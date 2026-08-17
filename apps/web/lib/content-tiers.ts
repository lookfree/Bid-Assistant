/** 标书生成计费阶梯（与后端 services/content-pricing.ts 的 ContentTier 同构）。
 *  maxChars=null 为顶档（无上限）。数值一律来自后端实时配置，前端不留静态副本。 */
export type ContentTier = { maxChars: number | null; cost: number }

/** 阈值的中文短写：5万 / 1.2万 / 8000。
 *  小数位一律**向下**取到 0.1 万：宁可少说也绝不多说。上取整（toFixed）会把 50500 写成
 *  「≤5.1万字」，用户按 5.09 万字以为还在本档，实际已落下一档——展示价与实扣价不符。
 *  用 n/1000 做整数除法而非 wan*10，避免 5.05 这类值在浮点上先失真再取整。 */
export function fmtTierChars(n: number): string {
  if (n < 10_000) return String(n)
  return `${Math.floor(n / 1_000) / 10}万`
}

/** 阶梯 → 一句计费说明。空阶梯明示未配置，绝不编造价格。 */
export function tiersCostText(tiers: ContentTier[]): string {
  if (tiers.length === 0) return "计费阶梯未配置,请联系运营"
  const tail = ",按实际产出总字数分档结算"
  if (tiers.length === 1 && tiers[0].maxChars === null) return `${tiers[0].cost} 积分/次${tail}`
  const parts = tiers.map((t) =>
    t.maxChars === null ? `更多 ${t.cost} 积分` : `≤${fmtTierChars(t.maxChars)}字 ${t.cost} 积分`,
  )
  return `${parts.join(" · ")}${tail}`
}

/** 目标字数 → 该档积分（与后端 services/content-pricing.ts 的 costForChars 同构）。
 *  阶梯为空/没有能覆盖该字数的档 → null：**绝不编一个价格**（宁可按钮上写计费口径，
 *  也不能显示一个和实扣不符的数字——展示价与实扣价不符是计费红线）。 */
export function costForChars(tiers: ContentTier[], chars: number): number | null {
  if (!tiers.length) return null
  const sorted = [...tiers].sort((a, b) => (a.maxChars ?? Infinity) - (b.maxChars ?? Infinity))
  const hit = sorted.find((t) => t.maxChars === null || chars <= t.maxChars)
  return hit ? hit.cost : null
}

/** 下一步按钮敢不敢**直接授权付费跑**（2026-08-17 用户口径「少让用户点一步」+ 评审 F2/F3）。
 *  一个印着积分、点了就扣钱的按钮，只有在「确实能跑」且「价格确实算得出」时才该出现：
 *  · 多包件未选包 → 服务端会 400 package_required，按钮承诺付费却把人丢进错误页；
 *  · 计费口径没到手（overview 拉取失败且 useMembership 不重试）→ 写死的兜底价可能与
 *    后台实配不符，那是展示价与实扣价不符（计费红线）。
 *  两种情况都退回纯导航，让用户到下一页按常规流程走。 */
export function canAutoStartOutline(o: {
  kind?: string
  outlineDone: boolean
  packageCount: number
  selectedPackageId: string | null
  outlineCost: number | null
}): boolean {
  if (o.kind === "review" || o.outlineDone) return false
  if (o.packageCount > 1 && !o.selectedPackageId) return false
  return o.outlineCost != null
}
