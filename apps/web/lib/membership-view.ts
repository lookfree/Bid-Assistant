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

/** 按 tierId 索引后端套餐（渲染时叠加到静态文案卡上）。 */
export function plansByTier(ov: MembershipOverview | null): Map<TierId, PlanView> {
  const m = new Map<TierId, PlanView>()
  for (const p of ov?.plans ?? []) m.set(p.tierId, p)
  return m
}
