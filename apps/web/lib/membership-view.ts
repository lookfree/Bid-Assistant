import type { MembershipOverview, PlanView, SubscriptionView, TierId } from "./membership-types"

// 会员中心页的纯展示/映射逻辑（spec308，抽出便于 bun:test 覆盖，页面只做渲染）。

export const TIER_ORDER: TierId[] = ["free", "personal", "professional"]

/** 到期日展示：ISO → YYYY-MM-DD；无/非法 → 占位符。 */
export function formatPeriodEnd(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 会员权益判定口径：仅 status === "active" 视为付费会员；
 * past_due / expired / none 权益一律锁定（与免费口径一致），到期宽限不解锁权益。
 */
export function isMember(ov: MembershipOverview | null): boolean {
  return ov?.subscription.status === "active"
}

/** 订阅状态中文标签。 */
export function statusLabel(status: SubscriptionView["status"]): string {
  const m: Record<SubscriptionView["status"], string> = {
    active: "会员有效",
    past_due: "待续费",
    expired: "已过期",
    none: "免费体验中",
  }
  return m[status]
}

/** 某档相对当前档的状态：当前 / 已拥有（更低档）/ 下一档（建议升级）。 */
export function tierCardState(tierId: TierId, currentTierId: TierId): { isCurrent: boolean; isOwned: boolean; isNext: boolean } {
  const cur = TIER_ORDER.indexOf(currentTierId)
  const idx = TIER_ORDER.indexOf(tierId)
  return { isCurrent: idx === cur, isOwned: idx < cur, isNext: idx === cur + 1 }
}

/** 取某档某计费周期的价格（元）：优先后端 PlanView，缺则回退静态值。 */
export function planPriceYuan(plan: PlanView | undefined, billing: "month" | "year", fallback: number): number {
  if (!plan) return fallback
  return billing === "year" ? plan.priceYearYuan : plan.priceMonthYuan
}

/** 取某计费口径的单次积分消耗：优先后端实时口径（overview.creditCosts，运营可配），缺则回退默认值。 */
export function creditCostValue(ov: MembershipOverview | null, key: string, fallback: number): number {
  return ov?.creditCosts.find((c) => c.key === key)?.value ?? fallback
}

/** 按 tierId 索引后端套餐（渲染时叠加到静态文案卡上）。 */
export function plansByTier(ov: MembershipOverview | null): Map<TierId, PlanView> {
  const m = new Map<TierId, PlanView>()
  for (const p of ov?.plans ?? []) m.set(p.tierId, p)
  return m
}

/** 当前登录账号的展示串：昵称优先，其次打码手机号，都没有才回落"已登录"。
 *  会员中心此前完全不显示这是谁的账号——多号切换或代客操作时，用户无从确认自己在给谁充值。 */
export function accountLabel(user: { nickname?: string | null; phone?: string | null } | null): string {
  if (!user) return "—"
  if (user.nickname && user.phone) return `${user.nickname}（${user.phone}）`
  return user.nickname || user.phone || "已登录"
}

const CYCLE_CN: Record<string, string> = { month: "包月", quarter: "包季", year: "包年" }

/** 计费周期中文。无订阅/未知周期回占位符（不猜）。 */
export function billingCycleLabel(cycle: SubscriptionView["billingCycle"]): string {
  return (cycle && CYCLE_CN[cycle]) || "—"
}

/** 本期区间展示：开通日 ~ 到期日。缺任一端回占位符——半截区间比不显示更容易看错。 */
export function periodRangeLabel(sub: SubscriptionView | null): string {
  if (!sub || !sub.currentPeriodStart || !sub.currentPeriodEnd) return "—"
  return `${formatPeriodEnd(sub.currentPeriodStart)} ~ ${formatPeriodEnd(sub.currentPeriodEnd)}`
}

// 积分流水的用户侧文案。运营后台那套（admin-labels）是给内部看的，这里要说用户听得懂的话：
// 「预扣/结算/退还」是内部记账动作，用户只关心"这笔为什么加、为什么减"。
const CREDIT_TX_CN: Record<string, string> = {
  grant: "赠送到账",
  purchase: "充值到账",
  // 预扣/结算对读标、查重、审核表等每一步都会写，不只标书生成——别叫「生成预扣」
  hold: "使用预扣",
  settle: "用量结算",
  release: "失败退还",
  expire: "到期作废",
  referral_reward: "邀请奖励",
  refund_clawback: "退款收回",
  admin_adjust: "人工调整",
}

/** 流水类型中文。库外取值原样回显——真出现了要能报得出原文，而不是显示"未知"。 */
export function creditTxLabel(type: string): string {
  return CREDIT_TX_CN[type] ?? type
}

/** 变动额展示：正数带 +，负数自带 -。0 不该出现（流水都是有向的），出现了也如实显示。 */
export function creditAmountText(amount: number): string {
  return amount > 0 ? `+${amount}` : String(amount)
}

// 订单类型文案。取值与 payment_orders.type 的 DB 约束一致（recharge/purchase/renewal）。
// 不叫「会员续费」：首次开通也走这条，叫续费不准；更不叫「自动续费」——本产品不做代扣
// （架构 §6.2 是到期提醒 + 手动续费）。与运营后台 orderTypeLabel 保持同一说法。
const ORDER_TYPE_CN: Record<string, string> = {
  recharge: "积分充值",
  purchase: "单笔购买",
  renewal: "会员开通/续费",
}

export function orderTypeLabel(type: string): string {
  return ORDER_TYPE_CN[type] ?? type
}

/** 流水时间：到分钟。formatPeriodEnd 只到日，是给订阅到期日写的；
 *  一个下午跑三步会显示三条一模一样的日期，既看不出先后也对不上是哪一次运行。 */
export function formatTxTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 用户侧要展示的流水：滤掉**金额为 0** 的行。
 *  结算行写的是「预扣与实际用量的差额」，实际用量与预扣一致时差额就是 0（230 实测 190 条结算里
 *  181 条为 0）——余额没动，对用户是纯噪音；差额非零的结算是真退回的积分，必须留着。 */
export function visibleCreditTxs<T extends { amount: number }>(txs: T[]): T[] {
  return txs.filter((t) => t.amount !== 0)
}
