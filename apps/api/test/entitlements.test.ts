import { describe, it, expect, afterAll, setDefaultTimeout } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import { getEntitlements, featureLocked, lockRiskAdvice } from "../src/services/entitlements"
import { getDb, closeDb } from "../src/db/client"
import { users, plans, subscriptions } from "../src/db/schema"
import { makeTestPlan, makeLedgerUser, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // getEntitlements 连真库（跑法：./test-local.sh test/entitlements.test.ts）

// 档位权益执行层（评审修正）：plans.features 此前零执行消费方——运营配置不联动实际控制。
// 本套件锁定三件事：权益解析（订阅态/过期语义/免费档回落）、开关判定口径（显式 false 才锁）、
// review 结果的 advice 出口裁剪（非会员不下发,不再靠前端模糊遮真数据）。

const madeUsers: string[] = []
const madePlans: string[] = []

afterAll(async () => {
  await getDb().delete(subscriptions).where(inArray(subscriptions.userId, madeUsers))
  await getDb().delete(users).where(inArray(users.id, madeUsers))
  await getDb().delete(plans).where(inArray(plans.id, madePlans))
  await closeDb()
})

async function subUser(features: Record<string, unknown>, status: string, endOffsetMs: number | null): Promise<string> {
  const planId = await makeTestPlan((id) => madePlans.push(id), {})
  await getDb().update(plans).set({ features }).where(eq(plans.id, planId))
  const userId = await makeLedgerUser((id) => madeUsers.push(id))
  await getDb()
    .insert(subscriptions)
    .values({ userId, planId, status, currentPeriodEnd: endOffsetMs == null ? null : new Date(Date.now() + endOffsetMs) })
  return userId
}

describe("getEntitlements：订阅态 → 会员与档位 features", () => {
  it("active 且未过周期末 → member + 本档 features", async () => {
    const uid = await subUser({ rewrite: true, pptTemplate: true }, "active", 86_400_000)
    const ents = await getEntitlements(uid)
    expect(ents.member).toBe(true)
    expect(ents.features).toEqual({ rewrite: true, pptTemplate: true })
  })

  it("周期末已过（状态还挂着 active）→ 非会员（到期宽限不解锁权益）", async () => {
    const uid = await subUser({ rewrite: true }, "active", -60_000)
    expect((await getEntitlements(uid)).member).toBe(false)
  })

  it("无订阅 → 非会员，features 回落到免费档（plans.code='free'）", async () => {
    const uid = await makeLedgerUser((id) => madeUsers.push(id))
    const ents = await getEntitlements(uid)
    expect(ents.member).toBe(false)
    const [free] = await getDb().select().from(plans).where(eq(plans.code, "free")).limit(1)
    expect(ents.features).toEqual((free?.features as Record<string, unknown>) ?? {})
  })
})

describe("featureLocked：显式 false 才锁", () => {
  it("false=锁；true/缺键/非布尔=放行（旧数据不误伤,收紧靠运营显式配 false）", () => {
    const ents = { member: true, features: { rewrite: false, pptTemplate: true, weird: "no" } }
    expect(featureLocked(ents, "rewrite")).toBe(true)
    expect(featureLocked(ents, "pptTemplate")).toBe(false)
    expect(featureLocked(ents, "missing")).toBe(false)
    expect(featureLocked(ents, "weird")).toBe(false)
  })
})

describe("lockRiskAdvice：advice 出口裁剪", () => {
  it("items[].advice 置空 + adviceLocked 标志；其余字段原样", () => {
    const out = lockRiskAdvice({
      score: 45,
      items: [{ title: "缺认证", advice: "补 ISO27001", level: "高" }, { title: "无授权", advice: "补授权书" }],
      passedItems: ["格式合规"],
    }) as { adviceLocked: boolean; items: Array<{ advice: string; title: string }>; passedItems: string[] }
    expect(out.adviceLocked).toBe(true)
    expect(out.items.map((i) => i.advice)).toEqual(["", ""])
    expect(out.items[0]!.title).toBe("缺认证")
    expect(out.passedItems).toEqual(["格式合规"])
  })

  it("形状不符（null/数组/无 items）原样透传，绝不抛", () => {
    expect(lockRiskAdvice(null)).toBe(null)
    expect(lockRiskAdvice([1])).toEqual([1])
    expect(lockRiskAdvice({ findings: [] })).toEqual({ findings: [] })
  })
})
