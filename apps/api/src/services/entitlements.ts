import { eq } from "drizzle-orm"
import { getDb } from "../db/client"
import { plans, subscriptions } from "../db/schema"
import { subscriptionActive } from "./membership"

// 会员权益解析与执行门禁（评审修正）：plans.features 此前只是会员页展示文案，执行层零消费——
// 运营改配置不影响任何实际能力，且整改建议全量下发靠前端模糊遮挡（F12 可读）。
// 本模块是唯一判定点：路由据此拦功能（featureLocked）。

export type Entitlements = { member: boolean; features: Record<string, unknown> }

/** 当前用户权益：active 且未过周期末的订阅 → 会员 + 该档 features；否则免费档（plans.code='free'）
 *  features。过期语义与 membership.loadSubscription 一致：status 非 active 或 currentPeriodEnd 已过
 *  任一命中即非会员（到期宽限不解锁权益）。 */
// 免费档 features 短缓存（评审二轮:非会员每次权益判定都多一跳 DB 查这份准静态运营配置）。
// TTL 60s:运营改免费档权益最迟一分钟生效,与「无缓存直查」的付费档不冲突（付费档仍逐请求查）。
let freeCache: { features: Record<string, unknown>; exp: number } | null = null

/** 测试用：清掉免费档 features 缓存（测试内改 plans.features 后立即生效,不等 60s TTL）。 */
export function resetFreeEntitlementsCache(): void {
  freeCache = null
}

export async function getEntitlements(userId: string): Promise<Entitlements> {
  const db = getDb()
  const [row] = await db
    .select({ status: subscriptions.status, currentPeriodEnd: subscriptions.currentPeriodEnd, features: plans.features })
    .from(subscriptions)
    .innerJoin(plans, eq(subscriptions.planId, plans.id))
    .where(eq(subscriptions.userId, userId))
  // 「会员有效」谓词与会员中心同源（membership.subscriptionActive）,两处口径绝不漂移
  if (row && subscriptionActive(row)) return { member: true, features: row.features ?? {} }
  if (freeCache == null || freeCache.exp < Date.now()) {
    const [free] = await db.select({ features: plans.features }).from(plans).where(eq(plans.code, "free")).limit(1)
    freeCache = { features: free?.features ?? {}, exp: Date.now() + 60_000 }
  }
  return { member: false, features: freeCache.features }
}

/** 权益开关判定：**显式 false 才锁**——缺键/非布尔一律放行（旧数据/未配置不误伤既有用户；
 *  收紧某档能力=运营在后台把该键改成 false，即刻生效，不用发版）。 */
export function featureLocked(ents: Entitlements, key: string): boolean {
  return ents.features[key] === false
}

