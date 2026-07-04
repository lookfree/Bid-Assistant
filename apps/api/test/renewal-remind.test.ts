import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import { getDb, closeDb } from "../src/db/client"
import { users, plans, subscriptions } from "../src/db/schema"
import { scanRenewalReminders, type ReminderNotice } from "../src/services/renewal"
import { seedConfigs, setConfig } from "../src/services/config"
import { makeTestPlan, makeTestSubscription, TEST_TIMEOUT_MS } from "./repos/helpers"
import { DAY_MS } from "../src/services/renewal"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/renewal-remind.test.ts）

const madeUsers: string[] = []
const madePlans: string[] = []
let planId = ""

beforeAll(async () => {
  await seedConfigs() // renewal_reminder_days = [7,3,1]
  planId = await makeTestPlan((id) => madePlans.push(id), { name: "测试月卡-remind" })
})

afterAll(async () => {
  await setConfig("renewal_reminder_days", [7, 3, 1]) // 还原（自定义档用例改过）
  for (const id of madeUsers) await getDb().delete(users).where(eq(users.id, id)) // 订阅/提醒记录级联删
  await getDb().delete(plans).where(inArray(plans.id, madePlans))
  await closeDb()
})

const day = DAY_MS
const mkSub = (status: string, endOffsetMs: number) => makeTestSubscription((id) => madeUsers.push(id), planId, status, endOffsetMs)

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

  it("配置形状错误（标量而非数组）→ 回落默认档，不抛错断提醒", async () => {
    await setConfig("renewal_reminder_days", 7) // 错误形状：标量
    const cap = capture()
    const sub = await mkSub("active", 2 * day)
    cap.track(sub.id)
    await scanRenewalReminders(new Date(), { notify: cap.notify }) // raw.filter 若被直接调用会 TypeError
    expect(cap.notices).toHaveLength(1)
    expect(cap.notices[0]!.tierDays).toBe(3) // 用的是默认 [7,3,1]
    await setConfig("renewal_reminder_days", [7, 3, 1])
  })

  it("单条 notify 失败不毒死整轮：去重行回滚（下轮重试），其余订阅照常提醒", async () => {
    const cap = capture()
    const bad = await mkSub("active", 6 * day)
    const good = await mkSub("active", 6 * day)
    cap.track(bad.id)
    cap.track(good.id)
    const notify = async (n: ReminderNotice) => {
      if (n.subscriptionId === bad.id) throw new Error("短信网关 500")
      await cap.notify(n)
    }
    await scanRenewalReminders(new Date(), { notify })
    expect(cap.notices.map((n) => n.subscriptionId)).toContain(good.id) // 后续订阅未被中断

    await scanRenewalReminders(new Date(), { notify: cap.notify }) // 下一轮：坏号档位未被白耗，重试成功
    expect(cap.notices.map((n) => n.subscriptionId)).toContain(bad.id)
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
