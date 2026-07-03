import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { and, eq } from "drizzle-orm"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, paymentOrders, creditTransactions } from "../src/db/schema"
import { createOrder, markPaid, pollUntilFinal } from "../src/services/payment-orders"
import type { PaymentProvider, PaymentResult } from "../src/services/payment/provider"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/payment-orders.test.ts）

let userId = ""

beforeAll(async () => {
  const r = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  userId = r.user.id
})

afterAll(async () => {
  await getDb().delete(users).where(eq(users.id, userId)) // 订单/流水随 user 级联删
  await closeDb()
})

/** 只实现 query 的假 provider（轮询用）。 */
function queryOnly(fn: () => Promise<PaymentResult>): PaymentProvider {
  return {
    query: fn,
    createPayment: async () => {
      throw new Error("not used")
    },
    refund: async () => ({ ok: false }),
    verifyCallback: () => false,
  }
}

const grantRows = (orderId: string) =>
  getDb()
    .select()
    .from(creditTransactions)
    .where(and(eq(creditTransactions.userId, userId), eq(creditTransactions.idempotencyKey, `purchase:${orderId}`)))

describe("createOrder（服务端定价快照 + 幂等）", () => {
  it("建单：金额/积分快照落库，clientSn 全局唯一生成", async () => {
    const o = await createOrder({ userId, type: "recharge", amountCents: 100, creditsSnapshot: 100, idempotencyKey: `co-${userId}-1` })
    const [row] = await getDb().select().from(paymentOrders).where(eq(paymentOrders.id, o.id))
    expect(row!.status).toBe("created")
    expect(row!.amountCents).toBe(100)
    expect(row!.creditsSnapshot).toBe(100)
    expect(row!.clientSn.length).toBeGreaterThan(10)
  })

  it("同幂等键重复下单返回同一单（不重复建单）", async () => {
    const key = `co-${userId}-dup`
    const a = await createOrder({ userId, type: "recharge", amountCents: 100, creditsSnapshot: 100, idempotencyKey: key })
    const b = await createOrder({ userId, type: "recharge", amountCents: 100, creditsSnapshot: 100, idempotencyKey: key })
    expect(b.id).toBe(a.id)
    expect(b.clientSn).toBe(a.clientSn)
  })
})

describe("markPaid（状态机唯一赢家 + 金额校验 + 只入账一次）", () => {
  it("created→paid：写通道单号 + grant 快照积分一次；重复调用 no-op", async () => {
    const o = await createOrder({ userId, type: "recharge", amountCents: 100, creditsSnapshot: 100, idempotencyKey: `mp-${userId}-1` })
    const r1 = await markPaid(o.id, { sn: "sqb-1", tradeNo: "wx-1", payway: "3", paidAmountCents: 100 })
    expect(r1.paid).toBe(true)
    const [row] = await getDb().select().from(paymentOrders).where(eq(paymentOrders.id, o.id))
    expect(row!.status).toBe("paid")
    expect(row!.providerTradeNo).toBe("sqb-1")
    expect(row!.channelTradeNo).toBe("wx-1")
    expect(row!.payway).toBe("3")
    expect((await grantRows(o.id)).length).toBe(1)
    expect((await grantRows(o.id))[0]!.amount).toBe(100)
    expect((await grantRows(o.id))[0]!.type).toBe("purchase")

    const r2 = await markPaid(o.id, { sn: "sqb-1", paidAmountCents: 100 }) // 重复回调
    expect(r2.paid).toBe(false)
    expect((await grantRows(o.id)).length).toBe(1) // 仍只一条
  })

  it("并发 markPaid（回调 vs 轮询）只有一个赢家、grant 只一次", async () => {
    const o = await createOrder({ userId, type: "recharge", amountCents: 100, creditsSnapshot: 100, idempotencyKey: `mp-${userId}-race` })
    const results = await Promise.all(
      Array.from({ length: 8 }, () => markPaid(o.id, { sn: "sqb-r", paidAmountCents: 100 })),
    )
    expect(results.filter((r) => r.paid).length).toBe(1)
    expect((await grantRows(o.id)).length).toBe(1)
  })

  it("实付金额 != 订单快照 → 不置 paid、不入账（进对账，人工/spec306 清算）", async () => {
    const o = await createOrder({ userId, type: "recharge", amountCents: 100, creditsSnapshot: 100, idempotencyKey: `mp-${userId}-mm` })
    const r = await markPaid(o.id, { sn: "sqb-mm", paidAmountCents: 1 })
    expect(r.paid).toBe(false)
    expect(r.reason).toBe("amount_mismatch")
    const [row] = await getDb().select().from(paymentOrders).where(eq(paymentOrders.id, o.id))
    expect(row!.status).toBe("created") // 不动状态，留给对账
    expect((await grantRows(o.id)).length).toBe(0)
  })
})

describe("pollUntilFinal（官方轮询节奏，窗口尽头置 unknown）", () => {
  it("始终 pending：0-1min 每 3s、1-5min 每 10s、第 6 分钟最后一次 → unknown", async () => {
    const o = await createOrder({ userId, type: "recharge", amountCents: 100, creditsSnapshot: 100, idempotencyKey: `pl-${userId}-1` })
    const delays: number[] = []
    let queries = 0
    const provider = queryOnly(async () => {
      queries++
      return { status: "pending" }
    })
    const result = await pollUntilFinal(o.id, { provider, sleepFn: async (ms) => void delays.push(ms) })
    expect(result).toBe("unknown")
    const [row] = await getDb().select().from(paymentOrders).where(eq(paymentOrders.id, o.id))
    expect(row!.status).toBe("unknown") // 不置 failed——钱可能已付
    // 节奏：20 次 3s（首分钟）+ 24 次 10s（1-5min）+ 1 次跳到第 6 分钟
    expect(delays.filter((d) => d === 3000).length).toBe(20)
    expect(delays.filter((d) => d === 10000).length).toBe(24)
    expect(delays[delays.length - 1]).toBe(60000)
    expect(queries).toBe(delays.length)
  })

  it("轮询中途 PAID → markPaid 入账并返回 paid", async () => {
    const o = await createOrder({ userId, type: "recharge", amountCents: 100, creditsSnapshot: 100, idempotencyKey: `pl-${userId}-2` })
    let n = 0
    const provider = queryOnly(async () =>
      ++n < 3 ? { status: "pending" } : { status: "paid", sn: "sqb-p", tradeNo: "ali-1", payway: "2", totalAmountCents: 100 },
    )
    const result = await pollUntilFinal(o.id, { provider, sleepFn: async () => {} })
    expect(result).toBe("paid")
    const [row] = await getDb().select().from(paymentOrders).where(eq(paymentOrders.id, o.id))
    expect(row!.status).toBe("paid")
    expect((await grantRows(o.id)).length).toBe(1)
  })

  it("轮询查到终态 failed → created→failed（不入账）", async () => {
    const o = await createOrder({ userId, type: "recharge", amountCents: 100, creditsSnapshot: 100, idempotencyKey: `pl-${userId}-3` })
    const provider = queryOnly(async () => ({ status: "failed" }))
    const result = await pollUntilFinal(o.id, { provider, sleepFn: async () => {} })
    expect(result).toBe("failed")
    const [row] = await getDb().select().from(paymentOrders).where(eq(paymentOrders.id, o.id))
    expect(row!.status).toBe("failed")
    expect((await grantRows(o.id)).length).toBe(0)
  })
})
