import { and, eq } from "drizzle-orm"
import { getDb } from "../db/client"
import { plans } from "../db/schema"

// 会员套餐种子（参考产品定价图 2026-07-05）：3 档 × cycle。金额=分（禁浮点）。
// features 记录各档权益开关；free/personal 差异主要在每月积分，pro 额外解锁 5 项高级能力。
// 免费版每月积分=0（注册一次性送 200 走注册赠送逻辑，非订阅周期发放）。
// 年付 grantCreditsPerCycle = 月积分 × 12（"含每月 N 积分"口径；一次按年发放）。
type FeatureFlags = {
  export: boolean // 导出 Word/PDF（各档均可，消耗积分）
  riskReview: boolean // 废标风险审查
  dedupe: boolean // 标书查重
  rewrite: boolean // 逐章重写/一键改写（pro）
  pptTemplate: boolean // 企业 PPT 模板·历史述标（pro）
  priorityQueue: boolean // 优先算力队列（pro）
  longHistory: boolean // 历史项目与版本长期保存（pro）
  fullDedupe: boolean // 全维度指纹查重（pro；个人=标准维度）
}
const BASE: FeatureFlags = { export: true, riskReview: true, dedupe: true, rewrite: false, pptTemplate: false, priorityQueue: false, longHistory: false, fullDedupe: false }
const PRO: FeatureFlags = { export: true, riskReview: true, dedupe: true, rewrite: true, pptTemplate: true, priorityQueue: true, longHistory: true, fullDedupe: true }

export interface PlanSeed {
  name: string
  code: "free" | "personal" | "professional"
  billingCycle: "month" | "year"
  priceCents: number
  grantCreditsPerCycle: number
  features: FeatureFlags
}

export const PLAN_SEED: PlanSeed[] = [
  { name: "免费版", code: "free", billingCycle: "month", priceCents: 0, grantCreditsPerCycle: 0, features: BASE },
  { name: "个人版", code: "personal", billingCycle: "month", priceCents: 3900, grantCreditsPerCycle: 1200, features: BASE },
  { name: "个人版", code: "personal", billingCycle: "year", priceCents: 39900, grantCreditsPerCycle: 14400, features: BASE },
  { name: "专业版", code: "professional", billingCycle: "month", priceCents: 15900, grantCreditsPerCycle: 6000, features: PRO },
  { name: "专业版", code: "professional", billingCycle: "year", priceCents: 159900, grantCreditsPerCycle: 72000, features: PRO },
]

/** 幂等：仅当该 (code, billing_cycle) 无行时插入，避免覆盖运营已改的价格。 */
export async function seedPlans(): Promise<{ inserted: number }> {
  const db = getDb()
  let inserted = 0
  for (const p of PLAN_SEED) {
    const [exists] = await db
      .select({ id: plans.id })
      .from(plans)
      .where(and(eq(plans.code, p.code), eq(plans.billingCycle, p.billingCycle)))
    if (exists) continue
    await db.insert(plans).values({
      name: p.name,
      code: p.code,
      billingCycle: p.billingCycle,
      priceCents: p.priceCents,
      grantCreditsPerCycle: p.grantCreditsPerCycle,
      features: p.features,
      status: "active",
    })
    inserted++
  }
  return { inserted }
}
