import { describe, it, expect } from "bun:test"
import { creditCostValue, formatPeriodEnd, isMember, statusLabel, tierCardState, planPriceYuan, plansByTier, accountLabel, billingCycleLabel, periodRangeLabel } from "../lib/membership-view"
import type { MembershipOverview, PlanView, SubscriptionView } from "../lib/membership-types"

const plan = (tierId: PlanView["tierId"], m: number, y: number): PlanView => ({
  id: `p-${tierId}`,
  planIdMonth: `p-${tierId}-m`,
  planIdYear: `p-${tierId}-y`,
  name: tierId,
  tierId,
  priceMonthCents: m * 100,
  priceMonthYuan: m,
  priceYearCents: y * 100,
  priceYearYuan: y,
  grantCreditsPerCycle: 100,
  features: [],
  recommended: tierId === "professional",
})

describe("spec308 会员中心纯逻辑", () => {
  it("formatPeriodEnd：ISO→YYYY-MM-DD；null/非法→占位", () => {
    expect(formatPeriodEnd("2026-08-15T10:00:00.000Z")).toMatch(/^2026-08-1[45]$/) // 时区容差
    expect(formatPeriodEnd(null)).toBe("—")
    expect(formatPeriodEnd("not-a-date")).toBe("—")
  })

  it("isMember：仅 active 算会员权益；past_due/expired/none 与未加载均锁定", () => {
    const ov = (status: SubscriptionView["status"]) =>
      ({ subscription: { status } } as MembershipOverview)
    expect(isMember(ov("active"))).toBe(true)
    expect(isMember(ov("past_due"))).toBe(false)
    expect(isMember(ov("expired"))).toBe(false)
    expect(isMember(ov("none"))).toBe(false)
    expect(isMember(null)).toBe(false)
  })

  it("statusLabel 覆盖四态", () => {
    expect(statusLabel("active")).toBe("会员有效")
    expect(statusLabel("expired")).toBe("已过期")
    expect(statusLabel("none")).toBe("免费体验中")
    expect(statusLabel("past_due")).toBe("待续费")
  })

  it("tierCardState：当前/已拥有/下一档", () => {
    expect(tierCardState("personal", "personal")).toEqual({ isCurrent: true, isOwned: false, isNext: false })
    expect(tierCardState("free", "personal")).toEqual({ isCurrent: false, isOwned: true, isNext: false })
    expect(tierCardState("professional", "personal")).toEqual({ isCurrent: false, isOwned: false, isNext: true })
  })

  it("planPriceYuan：优先后端，缺则回退", () => {
    const p = plan("personal", 39, 399)
    expect(planPriceYuan(p, "month", 0)).toBe(39)
    expect(planPriceYuan(p, "year", 0)).toBe(399)
    expect(planPriceYuan(undefined, "month", 39)).toBe(39)
  })

  it("creditCostValue：优先后端实时口径，key 缺失/未加载回退默认值", () => {
    const ov = {
      creditCosts: [
        { key: "rewrite", feature: "逐章重写 / 改写", desc: "", value: 30, cost: "30 积分 / 次" },
        { key: "review", feature: "废标风险审查", desc: "", value: 66, cost: "66 积分 / 次" },
      ],
    } as MembershipOverview
    expect(creditCostValue(ov, "rewrite", 25)).toBe(30)
    expect(creditCostValue(ov, "review", 60)).toBe(66)
    expect(creditCostValue(ov, "export", 20)).toBe(20) // key 不在实时口径里 → 回退
    expect(creditCostValue(null, "rewrite", 25)).toBe(25) // overview 未加载 → 回退
  })

  it("plansByTier 建索引", () => {
    const ov = { plans: [plan("free", 0, 0), plan("personal", 39, 399)] } as MembershipOverview
    const m = plansByTier(ov)
    expect(m.get("personal")!.priceMonthYuan).toBe(39)
    expect(plansByTier(null).size).toBe(0)
  })
})

// 会员中心原先只显示套餐/积分/到期日，看不出「这是谁的账号」「本期从哪天到哪天」「按什么周期计费」。
describe("本账户信息", () => {
  it("昵称与手机号同时有 → 两个都显示（认号靠手机号，认人靠昵称）", () => {
    expect(accountLabel({ nickname: "老王", phone: "138****5678" })).toBe("老王（138****5678）")
  })

  it("只有其中之一就显示那一个", () => {
    expect(accountLabel({ nickname: "老王" })).toBe("老王")
    expect(accountLabel({ phone: "138****5678" })).toBe("138****5678")
  })

  it("都没有不显示空白，未登录给占位符", () => {
    expect(accountLabel({})).toBe("已登录")
    expect(accountLabel(null)).toBe("—")
  })

  it("计费周期中文；未知周期不猜", () => {
    expect(billingCycleLabel("month")).toBe("包月")
    expect(billingCycleLabel("quarter")).toBe("包季")
    expect(billingCycleLabel("year")).toBe("包年")
    expect(billingCycleLabel(null)).toBe("—")
  })

  it("本期区间要两端齐全才显示——半截区间比不显示更容易看错", () => {
    const sub = (s: string | null, e: string | null) =>
      ({ status: "active", planId: null, tierId: "personal", billingCycle: "month", currentPeriodStart: s, currentPeriodEnd: e }) as SubscriptionView
    expect(periodRangeLabel(sub("2026-08-05T00:00:00Z", "2026-09-05T00:00:00Z"))).toBe("2026-08-05 ~ 2026-09-05")
    expect(periodRangeLabel(sub(null, "2026-09-05T00:00:00Z"))).toBe("—")
    expect(periodRangeLabel(null)).toBe("—")
  })
})
