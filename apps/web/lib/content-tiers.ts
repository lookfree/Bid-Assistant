/** 标书生成计费阶梯（与后端 services/content-pricing.ts 的 ContentTier 同构）。
 *  maxChars=null 为顶档（无上限）。数值一律来自后端实时配置，前端不留静态副本。 */
export type ContentTier = { maxChars: number | null; cost: number }

/** 阈值的中文短写：5万 / 1.2万 / 8000。 */
export function fmtTierChars(n: number): string {
  if (n < 10_000) return String(n)
  const wan = n / 10_000
  return `${Number.isInteger(wan) ? wan : wan.toFixed(1)}万`
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
