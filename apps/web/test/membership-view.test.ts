import { describe, it, expect } from "bun:test"
import { formatPeriodEnd, statusLabel, tierCardState, planPriceYuan, plansByTier } from "../lib/membership-view"
import type { MembershipOverview, PlanView } from "../lib/membership-types"

const plan = (tierId: PlanView["tierId"], m: number, y: number): PlanView => ({
  id: `p-${tierId}`,
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

  it("plansByTier 建索引", () => {
    const ov = { plans: [plan("free", 0, 0), plan("personal", 39, 399)] } as MembershipOverview
    const m = plansByTier(ov)
    expect(m.get("personal")!.priceMonthYuan).toBe(39)
    expect(plansByTier(null).size).toBe(0)
  })
})
