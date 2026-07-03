import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { and, eq } from "drizzle-orm"
import { getDb, closeDb } from "../src/db/client"
import { users, paymentOrders, creditTransactions } from "../src/db/schema"
import { createOrder, markPaid, markFinal, pollUntilFinal, sweepStaleCreatedOrders } from "../src/services/payment-orders"
import { seedConfigs, setConfig } from "../src/services/config"
import type { PaymentResult } from "../src/services/payment/provider"
import { makeLedgerUser, TEST_TIMEOUT_MS } from "./repos/helpers"
import { stubProvider } from "./helpers/sqb-gateway"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/payment-orders.test.ts）

const madeUsers: string[] = []
let userId = ""

beforeAll(async () => {
  await seedConfigs()
  userId = await makeLedgerUser((id) => madeUsers.push(id))
})

afterAll(async () => {
  await setConfig("payment_poll", { windowMinutes: 6, fastSeconds: 3, slowSeconds: 10 }) // 还原（消毒用例改过）
  for (const id of madeUsers) await getDb().delete(users).where(eq(users.id, id)) // 订单/流水级联删
  await closeDb()
})


const grantRows = (orderId: string) =>
  getDb()
    .select()
    .from(creditTransactions)
    .where(and(eq(creditTransactions.userId, userId), eq(creditTransactions.idempotencyKey, `purchase:${orderId}`)))
const orderRow = async (id: string) => (await getDb().select().from(paymentOrders).where(eq(paymentOrders.id, id)))[0]
const mkOrder = (key: string) =>
  createOrder({ userId, type: "recharge", amountCents: 100, creditsSnapshot: 100, idempotencyKey: `${key}-${userId}` })

describe("createOrder（服务端定价快照 + 幂等）", () => {
  it("建单：金额/积分快照落库，clientSn 全局唯一生成", async () => {
    const o = await mkOrder("co-1")
    const row = await orderRow(o.id)
    expect(row!.status).toBe("created")
    expect(row!.amountCents).toBe(100)
    expect(row!.creditsSnapshot).toBe(100)
    expect(row!.clientSn.length).toBeGreaterThan(10)
  })

  it("同幂等键重复下单返回同一单（不重复建单）", async () => {
    const a = await mkOrder("co-dup")
    const b = await mkOrder("co-dup")
    expect(b.id).toBe(a.id)
    expect(b.clientSn).toBe(a.clientSn)
  })
})

describe("markPaid（状态机唯一赢家 + 金额铁律 + 事务入账只一次）", () => {
  it("created→paid：写通道单号 + grant 快照积分一次；重复调用 no-op", async () => {
    const o = await mkOrder("mp-1")
    const r1 = await markPaid(o.id, { sn: "sqb-1", tradeNo: "wx-1", payway: "3", paidAmountCents: 100 })
    expect(r1.paid).toBe(true)
    const row = await orderRow(o.id)
    expect(row!.status).toBe("paid")
    expect(row!.providerTradeNo).toBe("sqb-1")
    expect(row!.channelTradeNo).toBe("wx-1")
    expect(row!.payway).toBe("3")
    const grants = await grantRows(o.id)
    expect(grants.length).toBe(1)
    expect(grants[0]!.amount).toBe(100)
    expect(grants[0]!.type).toBe("purchase")

    const r2 = await markPaid(o.id, { sn: "sqb-1", paidAmountCents: 100 }) // 重复回调
    expect(r2.paid).toBe(false)
    expect(r2.reason).toBe("already_final")
    expect((await grantRows(o.id)).length).toBe(1) // 仍只一条
  })

  it("并发 markPaid（回调 vs 轮询）只有一个赢家、grant 只一次", async () => {
    const o = await mkOrder("mp-race")
    const results = await Promise.all(Array.from({ length: 8 }, () => markPaid(o.id, { sn: "sqb-r", paidAmountCents: 100 })))
    expect(results.filter((r) => r.paid).length).toBe(1)
    expect((await grantRows(o.id)).length).toBe(1)
  })

  it("实付金额 != 快照 → 不入账、订单置 unknown 进对账队列", async () => {
    const o = await mkOrder("mp-mm")
    const r = await markPaid(o.id, { sn: "sqb-mm", paidAmountCents: 1 })
    expect(r).toEqual({ paid: false, reason: "amount_mismatch" })
    expect((await orderRow(o.id))!.status).toBe("unknown") // spec306 对账扫 unknown，不能留 created（对账扫不到）
    expect((await grantRows(o.id)).length).toBe(0)
  })

  it("实付金额缺失 → 同样不入账（铁律是必须校验，不是有金额才校验）", async () => {
    const o = await mkOrder("mp-miss")
    const r = await markPaid(o.id, { sn: "sqb-miss" }) // 通道没给 total_amount
    expect(r).toEqual({ paid: false, reason: "amount_missing" })
    expect((await orderRow(o.id))!.status).toBe("unknown")
    expect((await grantRows(o.id)).length).toBe(0)
  })

  it("unknown→paid：窗口尽头/金额异常后迟到的有效 PAID 仍要入账（unknown 非终态）", async () => {
    const o = await mkOrder("mp-late")
    await markFinal(o.id, "unknown") // 模拟轮询窗口用尽
    const r = await markPaid(o.id, { sn: "sqb-late", paidAmountCents: 100 })
    expect(r.paid).toBe(true)
    expect((await orderRow(o.id))!.status).toBe("paid")
    expect((await grantRows(o.id)).length).toBe(1)
  })

  it("grant 失败整体回滚：状态不动，重试可重新入账（杜绝 paid-无积分 的不可见资损）", async () => {
    const o = await mkOrder("mp-atomic")
    await expect(
      markPaid(o.id, { sn: "sqb-a", paidAmountCents: 100 }, { grantFn: async () => Promise.reject(new Error("DB 抖动")) }),
    ).rejects.toThrow("DB 抖动")
    expect((await orderRow(o.id))!.status).toBe("created") // 状态与入账同事务回滚
    expect((await grantRows(o.id)).length).toBe(0)

    const retry = await markPaid(o.id, { sn: "sqb-a", paidAmountCents: 100 }) // 通道重试/轮询重新驱动
    expect(retry.paid).toBe(true)
    expect((await grantRows(o.id)).length).toBe(1)
  })
})

describe("pollUntilFinal（官方轮询节奏，窗口尽头置 unknown）", () => {
  it("始终 pending：0-1min 每 3s、1-5min 每 10s、第 6 分钟最后一次 → unknown", async () => {
    const o = await mkOrder("pl-1")
    const delays: number[] = []
    let queries = 0
    const provider = stubProvider({ query: async () => {
      queries++
      return { status: "pending" }
    } })
    const result = await pollUntilFinal(o.id, { provider, sleepFn: async (ms) => void delays.push(ms) })
    expect(result).toBe("unknown")
    expect((await orderRow(o.id))!.status).toBe("unknown") // 不置 failed——钱可能已付
    // 节奏：20 次 3s（首分钟）+ 24 次 10s（1-5min）+ 1 次跳到第 6 分钟
    expect(delays.filter((d) => d === 3000).length).toBe(20)
    expect(delays.filter((d) => d === 10000).length).toBe(24)
    expect(delays[delays.length - 1]).toBe(60000)
    expect(queries).toBe(delays.length)
  })

  it("轮询中途 PAID → markPaid 入账并返回 paid", async () => {
    const o = await mkOrder("pl-2")
    let n = 0
    const provider = stubProvider({
      query: async () => (++n < 3 ? { status: "pending" } : { status: "paid", sn: "sqb-p", tradeNo: "ali-1", payway: "2", totalAmountCents: 100 }),
    })
    const result = await pollUntilFinal(o.id, { provider, sleepFn: async () => {} })
    expect(result).toBe("paid")
    expect((await orderRow(o.id))!.status).toBe("paid")
    expect((await grantRows(o.id)).length).toBe(1)
  })

  it("轮询查到终态 failed → created→failed（不入账）", async () => {
    const o = await mkOrder("pl-3")
    const provider = stubProvider({ query: async () => ({ status: "failed" }) })
    const result = await pollUntilFinal(o.id, { provider, sleepFn: async () => {} })
    expect(result).toBe("failed")
    expect((await orderRow(o.id))!.status).toBe("failed")
    expect((await grantRows(o.id)).length).toBe(0)
  })

  it("轮询查到 PAID 但金额不符 → 停止轮询、订单 unknown、不入账（不误报 paid）", async () => {
    const o = await mkOrder("pl-mm")
    const provider = stubProvider({ query: async () => ({ status: "paid", sn: "sqb-x", totalAmountCents: 1 }) })
    const result = await pollUntilFinal(o.id, { provider, sleepFn: async () => {} })
    expect(result).toBe("unknown")
    expect((await orderRow(o.id))!.status).toBe("unknown")
    expect((await grantRows(o.id)).length).toBe(0)
  })

  it("payment_poll 配置非法（fastSeconds=0 会死循环）→ 回落官方默认节奏", async () => {
    await setConfig("payment_poll", { windowMinutes: 6, fastSeconds: 0, slowSeconds: -5 })
    const o = await mkOrder("pl-cfg")
    const delays: number[] = []
    const provider = stubProvider({})
    const result = await pollUntilFinal(o.id, { provider, sleepFn: async (ms) => void delays.push(ms) })
    expect(result).toBe("unknown") // 循环正常收敛（配置若被采纳会 elapsed+=0 死循环）
    expect(delays.filter((d) => d === 3000).length).toBe(20) // 用的是默认 3s/10s
    expect(delays.filter((d) => d === 10000).length).toBe(24)
    await setConfig("payment_poll", { windowMinutes: 6, fastSeconds: 3, slowSeconds: 10 })
  })
})

describe("sweepStaleCreatedOrders（滞留单扫描：治轮询孤儿）", () => {
  const backdate = (orderId: string, minutesAgo: number) =>
    getDb()
      .update(paymentOrders)
      .set({ createdAt: new Date(Date.now() - minutesAgo * 60_000) })
      .where(eq(paymentOrders.id, orderId))

  it("超窗 created 单：通道已付 → 补入账；仍 pending → unknown 待对账；新单不动", async () => {
    const paidOrder = await mkOrder("sw-paid")
    const pendingOrder = await mkOrder("sw-pend")
    const freshOrder = await mkOrder("sw-fresh")
    await backdate(paidOrder.id, 10)
    await backdate(pendingOrder.id, 10)

    const bySn = new Map<string, PaymentResult>([
      [paidOrder.clientSn, { status: "paid", sn: "sqb-sw", totalAmountCents: 100 }],
      [pendingOrder.clientSn, { status: "pending" }],
    ])
    const asked: string[] = []
    const provider = stubProvider({
      query: async (clientSn) => {
        asked.push(clientSn)
        return bySn.get(clientSn) ?? { status: "pending" }
      },
    })
    const handled = await sweepStaleCreatedOrders(provider)
    expect(handled).toBeGreaterThanOrEqual(2)
    expect((await orderRow(paidOrder.id))!.status).toBe("paid") // 孤儿单补入账
    expect((await grantRows(paidOrder.id)).length).toBe(1)
    expect((await orderRow(pendingOrder.id))!.status).toBe("unknown") // 超窗 pending → 对账
    expect((await orderRow(freshOrder.id))!.status).toBe("created") // 窗口内的单不抢
    expect(asked).not.toContain(freshOrder.clientSn)
  })

  it("重复扫描幂等：已处理单不再变化、不重复入账", async () => {
    const o = await mkOrder("sw-idem")
    await backdate(o.id, 10)
    const provider = stubProvider({ query: async () => ({ status: "paid", sn: "s", totalAmountCents: 100 }) })
    await sweepStaleCreatedOrders(provider)
    await sweepStaleCreatedOrders(provider) // 第二轮：单已 paid，不在 created 扫描范围
    expect((await orderRow(o.id))!.status).toBe("paid")
    expect((await grantRows(o.id)).length).toBe(1)
  })
})
