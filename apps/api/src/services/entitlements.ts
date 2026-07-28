import { eq } from "drizzle-orm"
import { getDb } from "../db/client"
import { plans, subscriptions } from "../db/schema"

// 会员权益解析与执行门禁（评审修正）：plans.features 此前只是会员页展示文案，执行层零消费——
// 运营改配置不影响任何实际能力，且整改建议全量下发靠前端模糊遮挡（F12 可读）。
// 本模块是唯一判定点：路由据此拦功能（featureLocked）、裁剪响应（lockRiskAdvice）。

export type Entitlements = { member: boolean; features: Record<string, unknown> }

/** 当前用户权益：active 且未过周期末的订阅 → 会员 + 该档 features；否则免费档（plans.code='free'）
 *  features。过期语义与 membership.loadSubscription 一致：status 非 active 或 currentPeriodEnd 已过
 *  任一命中即非会员（到期宽限不解锁权益）。 */
export async function getEntitlements(userId: string): Promise<Entitlements> {
  const db = getDb()
  const [row] = await db
    .select({ status: subscriptions.status, periodEnd: subscriptions.currentPeriodEnd, features: plans.features })
    .from(subscriptions)
    .innerJoin(plans, eq(subscriptions.planId, plans.id))
    .where(eq(subscriptions.userId, userId))
  const active = !!row && row.status === "active" && !(row.periodEnd != null && row.periodEnd.getTime() < Date.now())
  if (active) return { member: true, features: row.features ?? {} }
  const [free] = await db.select({ features: plans.features }).from(plans).where(eq(plans.code, "free")).limit(1)
  return { member: false, features: free?.features ?? {} }
}

/** 权益开关判定：**显式 false 才锁**——缺键/非布尔一律放行（旧数据/未配置不误伤既有用户；
 *  收紧某档能力=运营在后台把该键改成 false，即刻生效，不用发版）。 */
export function featureLocked(ents: Entitlements, key: string): boolean {
  return ents.features[key] === false
}

/** review 结果出口裁剪（作用于 camelCase 转换后的结果）：非会员不下发整改建议正文——
 *  items[].advice 置空 + 顶层 adviceLocked 标志（前端三个展示面据此渲染统一的解锁引导）。
 *  形状不符原样透传，绝不因裁剪逻辑挡结果交付；只在出口变换，库中数据不动。 */
export function lockRiskAdvice(result: unknown): unknown {
  if (result == null || typeof result !== "object" || Array.isArray(result)) return result
  const r = result as Record<string, unknown>
  if (!Array.isArray(r.items)) return result
  const items = r.items.map((it) =>
    it != null && typeof it === "object" && !Array.isArray(it) ? { ...(it as object), advice: "" } : it,
  )
  return { ...r, items, adviceLocked: true }
}
