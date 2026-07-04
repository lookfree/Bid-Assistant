import { describe, it, expect, afterAll, setDefaultTimeout } from "bun:test"
import { randomUUID } from "node:crypto"
import { eq, inArray } from "drizzle-orm"
import { computeOverview } from "../src/services/admin/overview"
import { getDb, closeDb } from "../src/db/client"
import { users, plans, subscriptions, paymentOrders, creditTransactions, bidProjects } from "../src/db/schema"
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
  })
})
