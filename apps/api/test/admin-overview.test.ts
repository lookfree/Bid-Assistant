import { describe, it, expect, afterAll, setDefaultTimeout } from "bun:test"
import { randomUUID } from "node:crypto"
import { eq, inArray } from "drizzle-orm"
import { computeOverview, computeTrend } from "../src/services/admin/overview"
import { getDb, closeDb } from "../src/db/client"
import { users, plans, subscriptions, paymentOrders, refunds, creditTransactions, bidProjects } from "../src/db/schema"
import { makeUserWithNickname, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/admin-overview.test.ts）

const madeUsers: string[] = []
const madePlans: string[] = []

afterAll(async () => {
  for (const id of madeUsers) await getDb().delete(users).where(eq(users.id, id)) // 级联删订阅/订单/流水/项目
  await getDb().delete(plans).where(inArray(plans.id, madePlans))
  await closeDb()
})

describe("spec310 概览聚合", () => {
  it("用户数/付费用户/今日收入/积分流水/活跃项目", async () => {
    const u1 = await makeUserWithNickname((id) => madeUsers.push(id))
    await makeUserWithNickname((id) => madeUsers.push(id))
    const [plan] = await getDb().insert(plans).values({ name: "P", billingCycle: "month" }).returning()
    madePlans.push(plan!.id)
    await getDb().insert(subscriptions).values({ userId: u1, planId: plan!.id, status: "active" })
    await getDb().insert(paymentOrders).values({ userId: u1, type: "recharge", amountCents: 1000, status: "paid", clientSn: `t-${randomUUID()}`, idempotencyKey: `ov-${randomUUID()}` })
    await getDb().insert(creditTransactions).values({ userId: u1, type: "grant", amount: 100, idempotencyKey: `ov-${randomUUID()}` })
    await getDb().insert(bidProjects).values({ userId: u1, threadId: `th-${randomUUID()}`, status: "running" })

    const o = await computeOverview()
    expect(o.totalUsers).toBeGreaterThanOrEqual(2)
    expect(o.payingUsers).toBeGreaterThanOrEqual(1)
    expect(o.todayRevenueCents).toBeGreaterThanOrEqual(1000)
    expect(o.creditTxCount).toBeGreaterThanOrEqual(1)
    expect(o.activeProjects).toBeGreaterThanOrEqual(1)
    expect(o.totalRevenueCents).toBeGreaterThanOrEqual(1000)   // 看板「总营收」
  })

  it("营收按实收算：部分退款的订单仍是 paid，那部分必须从总营收/今日营收里减掉", async () => {
    const u = await makeUserWithNickname((id) => madeUsers.push(id))
    const before = await computeOverview()
    const [order] = await getDb()
      .insert(paymentOrders)
      .values({ userId: u, type: "recharge", amountCents: 5000, status: "paid", clientSn: `t-${randomUUID()}`, idempotencyKey: `ov-${randomUUID()}` })
      .returning()
    // 部分退款 2000：订单**有意保持 paid**（剩余额度还能继续退），只 sum 订单就会虚增 2000
    await getDb().insert(refunds).values({ orderId: order!.id, amountCents: 2000, status: "done", operator: "ops" })
    // 另一条 failed 的退款不该被减掉（钱没退出去）
    await getDb().insert(refunds).values({ orderId: order!.id, amountCents: 1000, status: "failed", operator: "ops" })

    const after = await computeOverview()
    expect(after.totalRevenueCents - before.totalRevenueCents).toBe(3000)
    expect(after.todayRevenueCents - before.todayRevenueCents).toBe(3000)
  })

  it("全额退款不重复扣：订单已翻 refunded 就不在已支付合计里，退款额不能再减一次", async () => {
    // 230 实测（2026-08-05）：两笔全额退款共 1100 分，对应订单都已是 refunded、本就不在合计内，
    // 却又被减了一遍 → 今日营收显示 ¥28.11，实际 ¥39.11。注释写的规则是对的，SQL 没照做。
    const u = await makeUserWithNickname((id) => madeUsers.push(id))
    const before = await computeOverview()
    const [order] = await getDb()
      .insert(paymentOrders)
      .values({ userId: u, type: "recharge", amountCents: 4000, status: "paid", clientSn: `t-${randomUUID()}`, idempotencyKey: `ov-${randomUUID()}` })
      .returning()
    const mid = await computeOverview()
    expect(mid.todayRevenueCents - before.todayRevenueCents).toBe(4000)

    // 退满 → 订单翻 refunded（与 refunds.ts 的落账一致）：净额应回到 0，而不是 -4000
    await getDb().insert(refunds).values({ orderId: order!.id, amountCents: 4000, status: "done", operator: "ops" })
    await getDb().update(paymentOrders).set({ status: "refunded" }).where(eq(paymentOrders.id, order!.id))

    const after = await computeOverview()
    expect(after.todayRevenueCents - before.todayRevenueCents).toBe(0)
    expect(after.totalRevenueCents - before.totalRevenueCents).toBe(0)
  })

  it("趋势时序：不因 to_char 时区绑参撞 GROUP BY 报错，且当日营收/积分入桶", async () => {
    // 回归：dayExpr 若用绑定参数 ${TZ}，SELECT/GROUP BY 各得一个占位符 → Postgres 500。此处 5000 分/200 分
    const u = await makeUserWithNickname((id) => madeUsers.push(id))
    await getDb().insert(paymentOrders).values({ userId: u, type: "recharge", amountCents: 5000, status: "paid", clientSn: `t-${randomUUID()}`, idempotencyKey: `tr-${randomUUID()}` })
    await getDb().insert(creditTransactions).values({ userId: u, type: "grant", amount: 200, idempotencyKey: `tr-${randomUUID()}` })

    const trend = await computeTrend(14) // 不抛即已证明 GROUP BY 匹配
    expect(trend.length).toBe(14)
    const today = trend[trend.length - 1]!
    expect(today.revenue).toBeGreaterThanOrEqual(50) // 5000 分 = 50 元
    expect(today.credits).toBeGreaterThanOrEqual(200)
  })
})
