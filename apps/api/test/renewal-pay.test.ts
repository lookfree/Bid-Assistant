import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { and, eq, inArray } from "drizzle-orm"
import { getDb, closeDb } from "../src/db/client"
import { users, plans, subscriptions, creditTransactions, paymentOrders } from "../src/db/schema"
import { createOrder, markPaid } from "../src/services/payment-orders"
import { seedConfigs } from "../src/services/config"
import { makeLedgerUser, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/renewal-pay.test.ts）

const madeUsers: string[] = []
const madePlans: string[] = []
let planId = ""

beforeAll(async () => {
  await seedConfigs()
  const [p] = await getDb()
    .insert(plans)
    .values({ name: "测试月卡-pay", priceCents: 1000, billingCycle: "month", grantCreditsPerCycle: 100 })
    .returning()
  planId = p!.id
  madePlans.push(planId)
})

afterAll(async () => {
  for (const id of madeUsers) await getDb().delete(users).where(eq(users.id, id))
  await getDb().delete(plans).where(inArray(plans.id, madePlans))
  await closeDb()
})

const day = 86_400_000
const mkUser = () => makeLedgerUser((id) => madeUsers.push(id))
const mkRenewalOrder = (userId: string, key: string) =>
  createOrder({
    userId,
    type: "renewal",
    amountCents: 1000,
    planId,
    cycleSnapshot: "month",
    creditsSnapshot: 100, // 权益快照：下单时锁定（运营改套餐不影响在途单）
    idempotencyKey: `${key}-${userId}`,
  })
const subOf = async (userId: string) => (await getDb().select().from(subscriptions).where(eq(subscriptions.userId, userId)))[0]
const renewalGrants = (orderId: string) =>
  getDb()
    .select()
    .from(creditTransactions)
    .where(and(eq(creditTransactions.idempotencyKey, `renewal:${orderId}`)))

describe("spec305 续费入账（markPaid type=renewal 分支，续期+发积分同事务恰好一次）", () => {
  it("未过期续费：从 current_period_end 顺延一周期（不吞剩余天数），发当期积分一次", async () => {
    const userId = await mkUser()
    const oldEnd = new Date(Date.now() + 10 * day) // 还剩 10 天
    await getDb().insert(subscriptions).values({ userId, planId, status: "active", currentPeriodEnd: oldEnd })

    const o = await mkRenewalOrder(userId, "rp-extend")
    const r = await markPaid(o.id, { sn: "sqb-rn1", paidAmountCents: 1000 })
    expect(r.paid).toBe(true)

    const sub = (await subOf(userId))!
    expect(sub.status).toBe("active")
    // 顺延基准 = 旧 periodEnd（+1 自然月，UTC 口径），剩余 10 天没被吞
    const expected = new Date(oldEnd)
    expected.setUTCMonth(expected.getUTCMonth() + 1)
    expect(sub.currentPeriodEnd!.getTime()).toBe(expected.getTime())
    expect(sub.currentPeriodStart!.getTime()).toBe(oldEnd.getTime())

    const grants = await renewalGrants(o.id)
    expect(grants.length).toBe(1)
    expect(grants[0]!.amount).toBe(100)
    expect(grants[0]!.expireAt!.getTime()).toBe(sub.currentPeriodEnd!.getTime()) // 当期积分随周期作废

    // 重复回调：markPaid already_final，不重复续期/发放
    const r2 = await markPaid(o.id, { sn: "sqb-rn1", paidAmountCents: 1000 })
    expect(r2.paid).toBe(false)
    expect((await subOf(userId))!.currentPeriodEnd!.getTime()).toBe(expected.getTime())
    expect((await renewalGrants(o.id)).length).toBe(1)
  })

  it("已过期（expired）续费：从支付时刻起新周期，状态复活为 active", async () => {
    const userId = await mkUser()
    await getDb()
      .insert(subscriptions)
      .values({ userId, planId, status: "expired", currentPeriodEnd: new Date(Date.now() - 30 * day) })

    const before = Date.now()
    const o = await mkRenewalOrder(userId, "rp-revive")
    await markPaid(o.id, { sn: "sqb-rn2", paidAmountCents: 1000 })

    const sub = (await subOf(userId))!
    expect(sub.status).toBe("active")
    expect(sub.currentPeriodStart!.getTime()).toBeGreaterThanOrEqual(before - 1000) // 基准≈支付时刻
    expect(sub.currentPeriodEnd!.getTime()).toBeGreaterThan(Date.now() + 27 * day) // 新周期约一个月
    expect((await renewalGrants(o.id)).length).toBe(1)
  })

  it("past_due 续费同样复活；无订阅行的用户续费直接建新订阅", async () => {
    const pastDueUser = await mkUser()
    await getDb()
      .insert(subscriptions)
      .values({ userId: pastDueUser, planId, status: "past_due", currentPeriodEnd: new Date(Date.now() - 1 * day) })
    const o1 = await mkRenewalOrder(pastDueUser, "rp-pd")
    await markPaid(o1.id, { sn: "s", paidAmountCents: 1000 })
    expect((await subOf(pastDueUser))!.status).toBe("active")

    const freshUser = await mkUser() // 从未订阅
    const o2 = await mkRenewalOrder(freshUser, "rp-new")
    await markPaid(o2.id, { sn: "s", paidAmountCents: 1000 })
    const sub = (await subOf(freshUser))!
    expect(sub.status).toBe("active")
    expect(sub.planId).toBe(planId)
  })

  it("renewal 单缺 planId 在下单即被拒（类型不变式，钱从严）", async () => {
    const userId = await mkUser()
    await expect(createOrder({ userId, type: "renewal", amountCents: 1000, idempotencyKey: `rp-noplan-${userId}` })).rejects.toThrow(
      /planId/,
    )
    await expect(
      createOrder({ userId, type: "recharge", amountCents: 100, planId, idempotencyKey: `rp-rcplan-${userId}` }),
    ).rejects.toThrow(/recharge/) // recharge 单带套餐同样被拒
  })

  it("并发两笔续费（不同订单）：周期正确叠加，不丢已付周期（订阅行锁串行化回归）", async () => {
    const userId = await mkUser()
    const oldEnd = new Date(Date.now() + 10 * day)
    await getDb().insert(subscriptions).values({ userId, planId, status: "active", currentPeriodEnd: oldEnd })
    const [o1, o2] = await Promise.all([mkRenewalOrder(userId, "rp-cc1"), mkRenewalOrder(userId, "rp-cc2")])
    const results = await Promise.all([
      markPaid(o1.id, { sn: "cc1", paidAmountCents: 1000 }),
      markPaid(o2.id, { sn: "cc2", paidAmountCents: 1000 }),
    ])
    expect(results.filter((r) => r.paid)).toHaveLength(2) // 两笔都是有效支付
    const sub = (await subOf(userId))!
    // 付两周期得两周期：base 顺延两次（+2 自然月），而不是双写同一个 +1 月
    const expected = new Date(oldEnd)
    expected.setUTCMonth(expected.getUTCMonth() + 2)
    expect(sub.currentPeriodEnd!.getTime()).toBe(expected.getTime())
    expect((await renewalGrants(o1.id)).length + (await renewalGrants(o2.id)).length).toBe(2)
  })

  it("权益以下单快照为准：支付前运营改套餐（周期/积分）不影响在途单", async () => {
    const userId = await mkUser()
    const o = await mkRenewalOrder(userId, "rp-snap") // 快照：month/100
    await getDb().update(plans).set({ grantCreditsPerCycle: 999, billingCycle: "year" }).where(eq(plans.id, planId))
    try {
      const before = Date.now()
      const r = await markPaid(o.id, { sn: "snap", paidAmountCents: 1000 })
      expect(r.paid).toBe(true)
      const sub = (await subOf(userId))!
      // 按快照延 1 个月（非改后的 1 年）
      expect(sub.currentPeriodEnd!.getTime()).toBeLessThan(before + 32 * day)
      const grants = await renewalGrants(o.id)
      expect(grants[0]!.amount).toBe(100) // 按快照发 100（非改后的 999）
    } finally {
      await getDb().update(plans).set({ grantCreditsPerCycle: 100, billingCycle: "month" }).where(eq(plans.id, planId))
    }
  })

  it("订单超可支付窗（7 天）后收到 PAID → 不入账（囤旧价单套利纵深防御）", async () => {
    const userId = await mkUser()
    const o = await mkRenewalOrder(userId, "rp-stale")
    await getDb()
      .update(paymentOrders)
      .set({ createdAt: new Date(Date.now() - 8 * day) })
      .where(eq(paymentOrders.id, o.id))
    const r = await markPaid(o.id, { sn: "stale", paidAmountCents: 1000 })
    expect(r).toEqual({ paid: false, reason: "stale_order" })
    expect((await getDb().select().from(paymentOrders).where(eq(paymentOrders.id, o.id)))[0]!.status).toBe("created")
    expect((await renewalGrants(o.id)).length).toBe(0)
  })

  it("续费金额校验沿用金额铁律：实付 != 套餐价不入账不续期", async () => {
    const userId = await mkUser()
    await getDb().insert(subscriptions).values({ userId, planId, status: "active", currentPeriodEnd: new Date(Date.now() + 5 * day) })
    const o = await mkRenewalOrder(userId, "rp-mm")
    const r = await markPaid(o.id, { sn: "s", paidAmountCents: 1 })
    expect(r).toEqual({ paid: false, reason: "amount_mismatch" })
    expect((await subOf(userId))!.status).toBe("active") // 周期没动
    expect((await renewalGrants(o.id)).length).toBe(0)
  })
})
