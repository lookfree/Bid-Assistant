import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { randomUUID } from "node:crypto"
import { and, eq, inArray, lt } from "drizzle-orm"
import { getDb, closeDb } from "../src/db/client"
import { users, plans, paymentOrders, refunds, creditTransactions } from "../src/db/schema"
import { createRefund, type RefundProvider } from "../src/services/refunds"
import { getBalance, grant } from "../src/services/credits"
import { seedConfigs } from "../src/services/config"
import { makeLedgerUser, makeTestPlan, TEST_TIMEOUT_MS } from "./repos/helpers"

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

async function mkPaidOrder(userId: string, amountCents: number, extra: Partial<typeof paymentOrders.$inferInsert> = {}) {
  const [o] = await getDb()
    .insert(paymentOrders)
    .values({
      userId,
      type: "recharge",
      amountCents,
      status: "paid",
      clientSn: `rf-${randomUUID()}`,
      idempotencyKey: `rf-${randomUUID()}`,
      providerTradeNo: `T-${randomUUID().slice(0, 8)}`,
      ...extra,
    })
    .returning()
  return o!
}

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

  it("部分退款：按比例扣回（退 40% 扣 40% 积分）", async () => {
    const userId = await mkUser()
    const order = await mkPaidOrder(userId, 1000)
    await grant(userId, 500, { type: "purchase", ref: order.id, idempotencyKey: `rf-g-${order.id}` })

    const res = await createRefund(
      { orderId: order.id, amountCents: 400, reason: "部分退", operator: "ops_bob" },
      { provider: okProvider() },
    )
    expect(res.status).toBe("done")
    expect(await getBalance(userId)).toBe(300) // 500 - round(500×0.4)=200
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

    // 先退 300（done），再退 300 → 累计 600 > 500 拒绝
    await createRefund({ orderId: order.id, amountCents: 300, reason: "第一笔", operator: "ops" }, { provider: okProvider() })
    // 部分退款后订单已置 refunded：二次退款在 paid 校验就被拒（累计护栏是并发窗口的兜底）
    await expect(createRefund({ orderId: order.id, amountCents: 300, reason: "第二笔", operator: "ops" }, { provider: okProvider() })).rejects.toThrow()
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
