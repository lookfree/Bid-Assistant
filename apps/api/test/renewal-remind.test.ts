import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import { getDb, closeDb } from "../src/db/client"
import { users, plans, subscriptions } from "../src/db/schema"
import { scanRenewalReminders, type ReminderNotice } from "../src/services/renewal"
import { seedConfigs, setConfig } from "../src/services/config"
import { makeLedgerUser, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/renewal-remind.test.ts）

const madeUsers: string[] = []
const madePlans: string[] = []
let planId = ""

beforeAll(async () => {
  await seedConfigs() // renewal_reminder_days = [7,3,1]
  const [p] = await getDb()
    .insert(plans)
    .values({ name: "测试月卡-remind", priceCents: 1000, billingCycle: "month" })
    .returning()
  planId = p!.id
  madePlans.push(planId)
})

afterAll(async () => {
  await setConfig("renewal_reminder_days", [7, 3, 1]) // 还原（自定义档用例改过）
  for (const id of madeUsers) await getDb().delete(users).where(eq(users.id, id)) // 订阅/提醒记录级联删
  await getDb().delete(plans).where(inArray(plans.id, madePlans))
  await closeDb()
})

const day = 86_400_000
const mkSub = async (status: string, endOffsetMs: number) => {
  const userId = await makeLedgerUser((id) => madeUsers.push(id))
  const [s] = await getDb()
    .insert(subscriptions)
    .values({ userId, planId, status, currentPeriodEnd: new Date(Date.now() + endOffsetMs) })
    .returning()
  return s!
}

/** 只统计本测试建的订阅（远程共享库可能有其他到期订阅）。 */
const capture = () => {
  const mine: ReminderNotice[] = []
  const ids = new Set<string>()
  return {
    track: (subId: string) => ids.add(subId),
    notices: mine,
    notify: async (n: ReminderNotice) => {
      if (ids.has(n.subscriptionId)) mine.push(n)
    },
  }
}

describe("spec305 到期提醒（T-7/T-3/T-1 档，落库幂等去重）", () => {
  it("T-7 窗口命中提醒一次；重复扫描去重；到期后不再提醒", async () => {
    const cap = capture()
    const sub = await mkSub("active", 6 * day) // 剩 6 天 → T-7 档
    cap.track(sub.id)
    await scanRenewalReminders(new Date(), { notify: cap.notify })
    expect(cap.notices).toHaveLength(1)
    expect(cap.notices[0]!.tierDays).toBe(7)

    await scanRenewalReminders(new Date(), { notify: cap.notify }) // 同档重复扫描 → 去重
    expect(cap.notices).toHaveLength(1)
  })

  it("只发最紧迫的一档：剩 2 天的新订阅只收 T-3，不被 T-7 连环轰炸", async () => {
    const cap = capture()
    const sub = await mkSub("active", 2 * day)
    cap.track(sub.id)
    await scanRenewalReminders(new Date(), { notify: cap.notify })
    expect(cap.notices).toHaveLength(1)
    expect(cap.notices[0]!.tierDays).toBe(3)
  })

  it("周期推进后各档独立：T-7 发过，剩 1 天时 T-1 仍要发", async () => {
    const cap = capture()
    const sub = await mkSub("active", 6 * day)
    cap.track(sub.id)
    await scanRenewalReminders(new Date(), { notify: cap.notify }) // T-7
    // 时间推进到只剩半天（不改 periodEnd，用未来的 now 模拟）
    const later = new Date(Date.now() + 5.5 * day)
    await scanRenewalReminders(later, { notify: cap.notify }) // T-1
    expect(cap.notices.map((n) => n.tierDays)).toEqual([7, 1])
  })

  it("非 active（past_due/expired）与远未到期的订阅不提醒", async () => {
    const cap = capture()
    const pastDue = await mkSub("past_due", 2 * day)
    const far = await mkSub("active", 30 * day)
    const gone = await mkSub("active", -1 * day) // 已过期：交给状态机，不提醒
    cap.track(pastDue.id)
    cap.track(far.id)
    cap.track(gone.id)
    await scanRenewalReminders(new Date(), { notify: cap.notify })
    expect(cap.notices).toHaveLength(0)
  })

  it("天数档读配置：改成 [10] 后 T-10 窗口生效", async () => {
    await setConfig("renewal_reminder_days", [10])
    const cap = capture()
    const sub = await mkSub("active", 9 * day)
    cap.track(sub.id)
    await scanRenewalReminders(new Date(), { notify: cap.notify })
    expect(cap.notices).toHaveLength(1)
    expect(cap.notices[0]!.tierDays).toBe(10)
    await setConfig("renewal_reminder_days", [7, 3, 1])
  })
})
