import { eq } from "drizzle-orm"
import { getDb } from "../db/client"
import { plans, subscriptions } from "../db/schema"
import { getBalance } from "./credits"
import { getConfig } from "./config"
import { centsToYuan } from "../lib/money"

// 会员中心聚合（spec308，架构 §5.3）：当前订阅 + 积分余额 + 套餐列表 + 渐进式展示（当前档+下一档）。
// 只读：余额一律走 spec302 credits.getBalance，不在此自算 Σ流水。tier 由 plans.code 分组（非中文名匹配）。

export type TierId = "free" | "personal" | "professional"
const TIER_ORDER: TierId[] = ["free", "personal", "professional"]

export interface PlanView {
  id: string
  // 按计费周期分别给出 plan 行 id：前端月/年切换时用对应 id 下单，避免年付误按月价成单（钱相关）
  planIdMonth: string | null
  planIdYear: string | null
  name: string
  tierId: TierId
  priceMonthCents: number
  priceMonthYuan: number
  priceYearCents: number
  priceYearYuan: number
  grantCreditsPerCycle: number
  features: { text: string; included: boolean }[]
  recommended: boolean
}
export interface RechargePackView {
  id: string
  credits: number
  amountCents: number
  amountYuan: number
}
type RechargePack = { id: string; amountCents: number; credits: number }
export interface SubscriptionView {
  status: "active" | "past_due" | "expired" | "none"
  planId: string | null
  tierId: TierId
  billingCycle: "month" | "quarter" | "year" | null
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
}
export interface MembershipOverview {
  subscription: SubscriptionView
  balance: number
  plans: PlanView[]
  rechargePacks: RechargePackView[] // 充值包目录（服务端定价为准；前端按 id 下单，消除前后端 id 不一致）
  progressive: { current: PlanView | null; next: PlanView | null }
}

type PlanRow = typeof plans.$inferSelect

/** DB features 开关 map → {text,included}[]（营销文案在前端 memberTiers，这里只忠实反映 DB 权益开关）。 */
function toFeatureList(features: Record<string, unknown> | null): { text: string; included: boolean }[] {
  if (!features) return []
  return Object.entries(features).map(([text, v]) => ({ text, included: Boolean(v) }))
}

/** 把同一档（code）的月/年 cycle 行聚成一条 PlanView。 */
function buildPlanView(code: TierId, rows: PlanRow[]): PlanView {
  const month = rows.find((r) => r.billingCycle === "month")
  const year = rows.find((r) => r.billingCycle === "year")
  const rep = month ?? year ?? rows[0]!
  return {
    id: rep.id,
    planIdMonth: month?.id ?? null,
    planIdYear: year?.id ?? null,
    name: rep.name,
    tierId: code,
    priceMonthCents: month?.priceCents ?? 0,
    priceMonthYuan: centsToYuan(month?.priceCents ?? 0),
    priceYearCents: year?.priceCents ?? 0,
    priceYearYuan: centsToYuan(year?.priceCents ?? 0),
    grantCreditsPerCycle: rep.grantCreditsPerCycle,
    features: toFeatureList(rep.features ?? null),
    recommended: code === "professional", // 主推档（对齐前端 memberTiers）
  }
}

/** 上架套餐按 code 分组成 tier 视图，按升级顺序排列（入参为已取的全量 plans 行，避免重复读表）。 */
function buildPlanViews(allRows: PlanRow[]): { list: PlanView[]; byTier: Map<TierId, PlanView> } {
  const grouped = new Map<TierId, PlanRow[]>()
  for (const r of allRows) {
    if (r.status !== "active") continue // 下架档不入会员分组
    if (!r.code || !TIER_ORDER.includes(r.code as TierId)) continue // 非会员档（如纯充值）不入分组
    const tier = r.code as TierId
    let arr = grouped.get(tier)
    if (!arr) grouped.set(tier, (arr = []))
    arr.push(r)
  }
  const byTier = new Map<TierId, PlanView>()
  for (const tier of TIER_ORDER) {
    const rs = grouped.get(tier)
    if (rs?.length) byTier.set(tier, buildPlanView(tier, rs))
  }
  return { list: TIER_ORDER.map((t) => byTier.get(t)).filter((p): p is PlanView => !!p), byTier }
}

/** 当前订阅视图：一人一订阅行（unique user_id），过期（状态或周期末<now）归一为 expired。
 *  档位/周期直接从已取的 allPlans 里按 planId 定位，免建全表映射。 */
async function loadSubscription(userId: string, allPlans: PlanRow[]): Promise<SubscriptionView> {
  const [row] = await getDb().select().from(subscriptions).where(eq(subscriptions.userId, userId))
  if (!row) return { status: "none", planId: null, tierId: "free", billingCycle: null, currentPeriodStart: null, currentPeriodEnd: null }
  const plan = allPlans.find((p) => p.id === row.planId)
  const expired = row.status === "expired" || (row.currentPeriodEnd != null && row.currentPeriodEnd.getTime() < Date.now())
  const status = expired ? "expired" : (row.status as "active" | "past_due")
  return {
    status,
    planId: row.planId,
    tierId: (plan?.code as TierId) ?? "free",
    billingCycle: (plan?.billingCycle as "month" | "quarter" | "year") ?? null,
    currentPeriodStart: row.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
  }
}

export async function getMembershipOverview(userId: string): Promise<MembershipOverview> {
  const allPlans = await getDb().select().from(plans)
  const { list, byTier } = buildPlanViews(allPlans)
  // 订阅/余额/充值包配置互不依赖，并行取（省往返）
  const [subscription, balance, packsCfg] = await Promise.all([
    loadSubscription(userId, allPlans),
    getBalance(userId),
    getConfig<RechargePack[]>("recharge_packs"),
  ])
  const rechargePacks = (packsCfg ?? []).map((p) => ({
    id: p.id,
    credits: p.credits,
    amountCents: p.amountCents,
    amountYuan: centsToYuan(p.amountCents),
  }))

  const current = byTier.get(subscription.tierId) ?? null
  const idx = TIER_ORDER.indexOf(subscription.tierId)
  const nextTier = idx >= 0 && idx < TIER_ORDER.length - 1 ? TIER_ORDER[idx + 1]! : null
  const next = nextTier ? (byTier.get(nextTier) ?? null) : null

  return { subscription, balance, plans: list, rechargePacks, progressive: { current, next } }
}
