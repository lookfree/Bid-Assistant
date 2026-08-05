import { describe, it, expect } from "bun:test"
import { creditCostValue, formatPeriodEnd, isMember, statusLabel, tierCardState, planPriceYuan, plansByTier, accountLabel, billingCycleLabel, periodRangeLabel, creditTxLabel, creditAmountText, orderTypeLabel } from "../lib/membership-view"
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

// 会员中心只显示余额与订单，从不显示积分花到哪去了——接口 /api/credits/transactions 与前端封装
// 早就有，全站却没有一个页面在用。会员退款产生的 refund_clawback 负向流水用户更该看得见。
describe("积分流水文案", () => {
  it("说用户听得懂的话，而不是内部记账动作名", () => {
    expect(creditTxLabel("purchase")).toBe("充值到账")
    expect(creditTxLabel("hold")).toBe("生成预扣")
    expect(creditTxLabel("release")).toBe("失败退还")
    expect(creditTxLabel("refund_clawback")).toBe("退款收回")
  })

  it("库外取值原样回显，不吞成「未知」", () => {
    expect(creditTxLabel("brand_new_type")).toBe("brand_new_type")
  })

  it("变动额带符号——不带正号的话，加和减在列表里看不出区别", () => {
    expect(creditAmountText(1200)).toBe("+1200")
    expect(creditAmountText(-20)).toBe("-20")
  })
})

// C 端会员中心的订单记录此前自带一份标签表，写的是「会员续费」「购买」——与运营后台不一致，
// 且首次开通也走 renewal 这条，叫「续费」不准。
describe("订单类型文案", () => {
  it("与运营后台同一说法，且不叫「自动续费」（本产品不做代扣）", () => {
    expect(orderTypeLabel("renewal")).toBe("会员开通/续费")
    expect(orderTypeLabel("renewal")).not.toContain("自动")
    expect(orderTypeLabel("recharge")).toBe("积分充值")
    expect(orderTypeLabel("purchase")).toBe("单笔购买")
  })

  it("库外取值原样回显", () => {
    expect(orderTypeLabel("weird")).toBe("weird")
  })
})
