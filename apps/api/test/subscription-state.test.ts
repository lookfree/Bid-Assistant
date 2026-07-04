import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import { getDb, closeDb } from "../src/db/client"
import { users, plans, subscriptions } from "../src/db/schema"
import { advanceSubscriptionStates } from "../src/services/renewal"
import { seedConfigs } from "../src/services/config"
import { makeTestPlan, makeTestSubscription, TEST_TIMEOUT_MS } from "./repos/helpers"
import { DAY_MS } from "../src/services/renewal"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/subscription-state.test.ts）

const madeUsers: string[] = []
let planId = ""
const madePlans: string[] = []

beforeAll(async () => {
  await seedConfigs() // renewal_grace_days = 3
  planId = await makeTestPlan((id) => madePlans.push(id), { name: "测试月卡-state" })
})

afterAll(async () => {
  for (const id of madeUsers) await getDb().delete(users).where(eq(users.id, id)) // 订阅级联删
  await getDb().delete(plans).where(inArray(plans.id, madePlans))
  await closeDb()
})

const day = DAY_MS
const mkSub = (status: string, endOffsetMs: number | null) => makeTestSubscription((id) => madeUsers.push(id), planId, status, endOffsetMs)
const statusOf = async (id: string) => (await getDb().select().from(subscriptions).where(eq(subscriptions.id, id)))[0]!.status

describe("spec305 订阅状态机（active→past_due→expired，Cron 条件 UPDATE 推进）", () => {
  it("到期的 active → past_due（宽限期内）；未到期不动", async () => {
    const dueSub = await mkSub("active", -1 * day) // 昨天到期
    const freshSub = await mkSub("active", +10 * day)
    await advanceSubscriptionStates(new Date())
    expect(await statusOf(dueSub.id)).toBe("past_due")
    expect(await statusOf(freshSub.id)).toBe("active")
  })

  it("宽限期（renewal_grace_days=3）用尽 → expired；宽限内保持 past_due", async () => {
    const inGrace = await mkSub("past_due", -2 * day) // 过期 2 天 < 宽限 3 天
    const beyond = await mkSub("past_due", -4 * day) // 过期 4 天 > 宽限
    await advanceSubscriptionStates(new Date())
    expect(await statusOf(inGrace.id)).toBe("past_due")
    expect(await statusOf(beyond.id)).toBe("expired")
  })

  it("一次推进可跨档：过期远超宽限的 active 同轮落到 expired；重复跑幂等", async () => {
    const longGone = await mkSub("active", -30 * day)
    const r1 = await advanceSubscriptionStates(new Date())
    expect(await statusOf(longGone.id)).toBe("expired") // active→past_due→expired 同轮完成
    expect(r1.pastDue + r1.expired).toBeGreaterThanOrEqual(1)
    const before = await statusOf(longGone.id)
    await advanceSubscriptionStates(new Date()) // 幂等：重复跑不再变化
    expect(await statusOf(longGone.id)).toBe(before)
  })

  it("current_period_end 为 NULL 的订阅不被推进（L1 null-guard 回归）", async () => {
    const nullEnd = await mkSub("active", null)
    await advanceSubscriptionStates(new Date())
    expect(await statusOf(nullEnd.id)).toBe("active")
  })
})
