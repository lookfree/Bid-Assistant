// 积分消耗口径的唯一真相（以 C 端 membership「积分消耗说明」为准）。
// 2026-07-29：**逐章改写移出计费**——费用统一由导出/下载侧承担，用户可放开改到满意；
// 改写路由已彻底不碰账本（不预扣/不结算/不看余额），故此处也不再列该项。
// 后端种子/会员总览、admin 配置、C 端展示都以此为准；default 为初始值（运营后台可改，存 billing_configs credit_cost.<key>）。
// 标书生成不在此列表：它按「产出总字数阶梯」计费（credit_cost.content_tiers），见 services/content-pricing.ts。
export const CREDIT_COST_ITEMS = [
  { key: "read", feature: "招标解读", desc: "识别评分点与关键条款", unit: "份", default: 20 },
  { key: "outline", feature: "提纲生成", desc: "技术标 + 商务标大纲", unit: "份", default: 30 },
  { key: "review", feature: "废标风险审查", desc: "全文风险体检 + 整改建议", unit: "次", default: 60 },
  { key: "dedupe", feature: "标书查重", desc: "多维指纹比对", unit: "次", default: 100 },
  { key: "present", feature: "述标演示生成", desc: "标书提炼为述标/答辩 PPT", unit: "次", default: 80 },
  { key: "export", feature: "导出 Word / PDF", desc: "整本投标文件导出（含无限次在线编辑与逐章改写）", unit: "次", default: 20 },
] as const

export type CreditCostItem = { key: string; feature: string; desc: string; value: number; cost: string }

/** 拼装各项的实时口径：值取 billing_configs 的 credit_cost.<key>，缺省回落 default。 */
export function buildCreditCosts(configs: Record<string, unknown>): CreditCostItem[] {
  return CREDIT_COST_ITEMS.map((i) => {
    const v = configs[`credit_cost.${i.key}`]
    const value = typeof v === "number" && Number.isFinite(v) ? v : i.default
    // 0 = 免费项：显示「免费」而非「0 积分 / 次」（后者像配置漏了）
    return { key: i.key, feature: i.feature, desc: i.desc, value, cost: value > 0 ? `${value} 积分 / ${i.unit}` : "免费" }
  })
}
