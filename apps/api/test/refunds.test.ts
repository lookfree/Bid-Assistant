import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { randomUUID } from "node:crypto"
import { and, eq, inArray, lt } from "drizzle-orm"
import { getDb, closeDb } from "../src/db/client"
import { users, plans, paymentOrders, refunds, creditTransactions, reconcileDiffs } from "../src/db/schema"
import { createRefund, type RefundProvider } from "../src/services/refunds"
import { scanStuckRefunds } from "../src/services/reconcile"
import { getBalance, grant, hold, settle } from "../src/services/credits"
import { seedConfigs } from "../src/services/config"
import { makeLedgerUser, makeTestOrder, makeTestPlan, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/refunds.test.ts）

const madeUsers: string[] = []
const madePlans: string[] = []
let planId = ""

beforeAll(async () => {
  await seedConfigs()
  planId = await makeTestPlan((id) => madePlans.push(id), { name: "测试月卡-refund" })
})

afterAll(async () => {
  for (const id of madeUsers) await getDb().delete(users).where(eq(users.id, id)) // 订单/退款/流水级联删
  await getDb().delete(plans).where(inArray(plans.id, madePlans))
  await closeDb()
})

const mkUser = () => makeLedgerUser((id) => madeUsers.push(id))

const mkPaidOrder = (userId: string, amountCents: number, extra: Partial<typeof paymentOrders.$inferInsert> = {}) =>
  makeTestOrder(userId, "paid", amountCents, { providerTradeNo: `T-${randomUUID().slice(0, 8)}`, ...extra })

const okProvider = (calls: Array<{ clientSn: string; refundSn: string; amountCents: number }> = []): RefundProvider => ({
  refund: async (a) => {
    calls.push(a)
    return { ok: true }
  },
})
const failProvider: RefundProvider = { refund: async () => ({ ok: false }) }

describe("spec306 退款编排（pending→done/failed，事务落账+扣回积分）", () => {
  it("全额退款：done + 订单 refunded + 按 ref=order 扣回已入账积分（负向 refund_clawback）", async () => {
    const userId = await mkUser()
    const order = await mkPaidOrder(userId, 1000)
    await grant(userId, 1000, { type: "purchase", ref: order.id, idempotencyKey: `rf-g-${order.id}` }) // 充值到账
    expect(await getBalance(userId)).toBe(1000)

    const calls: Array<{ clientSn: string; refundSn: string; amountCents: number }> = []
    const res = await createRefund(
      { orderId: order.id, amountCents: 1000, reason: "用户申请", operator: "ops_alice" },
      { provider: okProvider(calls) },
    )
    expect(res.status).toBe("done")
    expect(calls[0]!.clientSn).toBe(order.clientSn) // 按我方订单号退款
    expect(calls[0]!.refundSn).toBe(res.refundId) // 通道侧幂等键 = 退款单 id

    const [r] = await getDb().select().from(refunds).where(eq(refunds.id, res.refundId))
    expect(r!.status).toBe("done")
    expect(r!.operator).toBe("ops_alice")
    expect((await getDb().select().from(paymentOrders).where(eq(paymentOrders.id, order.id)))[0]!.status).toBe("refunded")

    const negatives = await getDb()
      .select()
      .from(creditTransactions)
      .where(and(eq(creditTransactions.userId, userId), lt(creditTransactions.amount, 0)))
    expect(negatives).toHaveLength(1)
    expect(negatives[0]!.type).toBe("refund_clawback")
    expect(negatives[0]!.amount).toBe(-1000)
    expect(await getBalance(userId)).toBe(0)
  })

  it("部分退款：订单留 paid（剩余额度可续退）、累计比例扣回不随笔数放大取整误差", async () => {
    const userId = await mkUser()
    const order = await mkPaidOrder(userId, 1000)
    await grant(userId, 500, { type: "purchase", ref: order.id, idempotencyKey: `rf-g-${order.id}` })

    const r1 = await createRefund({ orderId: order.id, amountCents: 400, reason: "部分退", operator: "ops_bob" }, { provider: okProvider() })
    expect(r1.status).toBe("done")
    expect(await getBalance(userId)).toBe(300) // 500 - round(500×0.4)=200
    expect((await getDb().select().from(paymentOrders).where(eq(paymentOrders.id, order.id)))[0]!.status).toBe("paid") // 未退满不翻转

    const r2 = await createRefund({ orderId: order.id, amountCents: 600, reason: "退剩余", operator: "ops_bob" }, { provider: okProvider() })
    expect(r2.status).toBe("done")
    expect(await getBalance(userId)).toBe(0) // 累计口径：round(500×1.0)-200=300，合计恰好 500
    expect((await getDb().select().from(paymentOrders).where(eq(paymentOrders.id, order.id)))[0]!.status).toBe("refunded") // 退满才翻转
  })

  it("通道抛错（结果不明）→ 保持 pending 不标 failed：占累计额度挡重试，防换 refundSn 双退", async () => {
    const userId = await mkUser()
    const order = await mkPaidOrder(userId, 500)
    const throwing: RefundProvider = {
      refund: async () => {
        throw new Error("收钱吧网关 HTTP 504")
      },
    }
    const res = await createRefund({ orderId: order.id, amountCents: 500, reason: "x", operator: "ops" }, { provider: throwing })
    expect(res.status).toBe("pending")
    expect((await getDb().select().from(refunds).where(eq(refunds.id, res.refundId)))[0]!.status).toBe("pending")
    // pending 占额度：重试被累计护栏挡住（必须先人工核对通道，防双退）
    await expect(
      createRefund({ orderId: order.id, amountCents: 500, reason: "重试", operator: "ops" }, { provider: okProvider() }),
    ).rejects.toThrow(/超过订单额/)
    // 卡死退款被扫描落 refund_stuck 差异（回拨 createdAt 模拟超时）
    await getDb().update(refunds).set({ createdAt: new Date(Date.now() - 2 * 3600_000) }).where(eq(refunds.id, res.refundId))
    const found = await scanStuckRefunds(new Date(), { alertHook: () => {} })
    expect(found).toBeGreaterThanOrEqual(1)
    const diffRows = await getDb().select().from(reconcileDiffs).where(eq(reconcileDiffs.subject, res.refundId))
    expect(diffRows.map((d) => d.diffType)).toContain("refund_stuck")
    await getDb().delete(reconcileDiffs).where(eq(reconcileDiffs.subject, res.refundId)) // 清理
  })

  it("扣回超过当前余额（用户已消费）默认拒绝；操作员携 allowNegativeBalance 才放行（余额转负）", async () => {
    const userId = await mkUser()
    const order = await mkPaidOrder(userId, 1000)
    await grant(userId, 1000, { type: "purchase", ref: order.id, idempotencyKey: `rf-g-${order.id}` })
    const { holdId } = await hold(userId, "read", { idempotencyKey: `rf-h-${userId}` })
    await settle(holdId, 10, { idempotencyKey: `rf-s-${userId}` }) // 已消费 10 → 余额 990 < 扣回 1000
    await expect(
      createRefund({ orderId: order.id, amountCents: 1000, reason: "x", operator: "ops" }, { provider: okProvider() }),
    ).rejects.toThrow(/超过当前余额/)
    const res = await createRefund(
      { orderId: order.id, amountCents: 1000, reason: "确认负余额", operator: "ops", allowNegativeBalance: true },
      { provider: okProvider() },
    )
    expect(res.status).toBe("done")
    expect(await getBalance(userId)).toBe(-10) // 欠账可见，审计可查
  })

  it("通道退款失败：refunds=failed，订单/积分原样不动", async () => {
    const userId = await mkUser()
    const order = await mkPaidOrder(userId, 500)
    await grant(userId, 500, { type: "purchase", ref: order.id, idempotencyKey: `rf-g-${order.id}` })

    const res = await createRefund({ orderId: order.id, amountCents: 500, reason: "x", operator: "ops_carol" }, { provider: failProvider })
    expect(res.status).toBe("failed")
    expect((await getDb().select().from(refunds).where(eq(refunds.id, res.refundId)))[0]!.status).toBe("failed")
    expect((await getDb().select().from(paymentOrders).where(eq(paymentOrders.id, order.id)))[0]!.status).toBe("paid")
    expect(await getBalance(userId)).toBe(500)
  })

  it("护栏：非 paid 单拒绝；超额拒绝；累计（含在途 pending）超额拒绝", async () => {
    const userId = await mkUser()
    const created = await mkPaidOrder(userId, 500, { status: "created" })
    await expect(createRefund({ orderId: created.id, amountCents: 100, reason: "x", operator: "ops" }, { provider: okProvider() })).rejects.toThrow(/非 paid/)

    const order = await mkPaidOrder(userId, 500)
    await expect(createRefund({ orderId: order.id, amountCents: 501, reason: "x", operator: "ops" }, { provider: okProvider() })).rejects.toThrow(/超过订单额/)

    // 先退 300（done，订单留 paid），再退 300 → 累计 600 > 500 被护栏拒绝
    await createRefund({ orderId: order.id, amountCents: 300, reason: "第一笔", operator: "ops" }, { provider: okProvider() })
    await expect(
      createRefund({ orderId: order.id, amountCents: 300, reason: "第二笔", operator: "ops" }, { provider: okProvider() }),
    ).rejects.toThrow(/超过订单额/)
  })

  it("C9 决策：renewal 单拒绝自动退款（须同时处置订阅周期，转人工）", async () => {
    const userId = await mkUser()
    const order = await mkPaidOrder(userId, 2000, { type: "renewal", planId, cycleSnapshot: "month", creditsSnapshot: 200 })
    await expect(
      createRefund({ orderId: order.id, amountCents: 2000, reason: "x", operator: "ops" }, { provider: okProvider() }),
    ).rejects.toThrow(/renewal|人工/)
    expect((await getDb().select().from(refunds).where(eq(refunds.orderId, order.id)))).toHaveLength(0) // 不建退款单
  })

  it("无入账积分的订单退款：不写负向流水", async () => {
    const userId = await mkUser()
    const order = await mkPaidOrder(userId, 300) // 无 ref=order 的正向流水
    const res = await createRefund({ orderId: order.id, amountCents: 300, reason: "x", operator: "ops" }, { provider: okProvider() })
    expect(res.status).toBe("done")
    const negatives = await getDb()
      .select()
      .from(creditTransactions)
      .where(and(eq(creditTransactions.userId, userId), lt(creditTransactions.amount, 0)))
    expect(negatives).toHaveLength(0)
  })
})
