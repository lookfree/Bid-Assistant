import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import { getDb, closeDb } from "../../src/db/client"
import { users, plans } from "../../src/db/schema"
import { getMembershipOverview } from "../../src/services/membership"
import { seedConfigs } from "../../src/services/config"
import { makeLedgerUser, makeTestPlan, makeTestSubscription, TEST_TIMEOUT_MS } from "../repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/services/membership.test.ts）

const DAY = 86_400_000
const madeUsers: string[] = []
const madePlans: string[] = []
const regUser = (id: string) => madeUsers.push(id)
const mkPlan = (o: Record<string, unknown>) => makeTestPlan((id) => madePlans.push(id), o)
let personalId = ""
let proId = ""

beforeAll(async () => {
  await seedConfigs() // recharge_packs 等配置（rechargePacks 断言用）
  await mkPlan({ name: "免费版", code: "free", priceCents: 0, billingCycle: "month", grantCreditsPerCycle: 200 })
  personalId = await mkPlan({ name: "个人版月", code: "personal", priceCents: 3900, billingCycle: "month", grantCreditsPerCycle: 1200 })
  proId = await mkPlan({ name: "专业版月", code: "professional", priceCents: 15900, billingCycle: "month", grantCreditsPerCycle: 6000 })
})
afterAll(async () => {
  for (const id of madeUsers) await getDb().delete(users).where(eq(users.id, id)) // 级联删订阅
  await getDb().delete(plans).where(inArray(plans.id, madePlans))
  await closeDb()
})

describe("spec308 会员中心聚合（渐进式当前档+下一档）", () => {
  it("未订阅用户：free 档 + 下一档 personal，plans 三档，余额走 getBalance", async () => {
    const userId = await makeLedgerUser(regUser)
    const ov = await getMembershipOverview(userId)
    expect(ov.subscription.status).toBe("none")
    expect(ov.subscription.tierId).toBe("free")
    expect(ov.subscription.currentPeriodEnd).toBeNull()
    expect(typeof ov.balance).toBe("number")
    expect(ov.plans.length).toBe(3)
    expect(ov.plans.map((p) => p.tierId)).toEqual(["free", "personal", "professional"])
    expect(ov.progressive.current!.tierId).toBe("free")
    expect(ov.progressive.next!.tierId).toBe("personal")
  })

  it("personal active：当前 personal、下一档 professional，周期末为 ISO 串", async () => {
    const sub = await makeTestSubscription(regUser, personalId, "active", 30 * DAY)
    const ov = await getMembershipOverview(sub.userId)
    expect(ov.subscription.tierId).toBe("personal")
    expect(ov.subscription.status).toBe("active")
    expect(ov.subscription.billingCycle).toBe("month")
    expect(typeof ov.subscription.currentPeriodEnd).toBe("string")
    expect(ov.progressive.current!.tierId).toBe("personal")
    expect(ov.progressive.next!.tierId).toBe("professional")
  })

  it("professional：已最高档，progressive.next 为 null", async () => {
    const sub = await makeTestSubscription(regUser, proId, "active", 30 * DAY)
    const ov = await getMembershipOverview(sub.userId)
    expect(ov.progressive.current!.tierId).toBe("professional")
    expect(ov.progressive.next).toBeNull()
  })

  it("过期订阅（周期末 < now）：status 归一为 expired，current 仍取该档", async () => {
    const sub = await makeTestSubscription(regUser, personalId, "active", -1000)
    const ov = await getMembershipOverview(sub.userId)
    expect(ov.subscription.status).toBe("expired")
    expect(ov.progressive.current!.tierId).toBe("personal")
  })

  it("金额换算一致：personal 月价 3900 分 = 39 元；月行 planIdMonth 就是该行", async () => {
    const userId = await makeLedgerUser(regUser)
    const ov = await getMembershipOverview(userId)
    const personal = ov.plans.find((p) => p.tierId === "personal")!
    expect(personal.priceMonthCents).toBe(3900)
    expect(personal.priceMonthYuan).toBe(39)
    expect(personal.planIdMonth).toBe(personalId) // 月付按月行 id 下单（避免年付误按月价，反之亦然）
    expect(personal.planIdYear).toBeNull() // 本档只种了月行
  })

  it("rechargePacks 来自配置，amountYuan 一致换算", async () => {
    const userId = await makeLedgerUser(regUser)
    const ov = await getMembershipOverview(userId)
    expect(ov.rechargePacks.length).toBeGreaterThanOrEqual(1)
    const p = ov.rechargePacks[0]!
    expect(p.amountYuan).toBe(p.amountCents / 100)
    expect(typeof p.id).toBe("string")
  })
})
