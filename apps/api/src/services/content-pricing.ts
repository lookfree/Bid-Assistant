import { getConfig } from "./config"

/** 标书生成计费阶梯的一档。maxChars=null 表示顶档（无上限）。
 *  落档规则：本次产出正文总字数 ≤ maxChars 即取该档（等于阈值落较低档）。 */
export type ContentTier = { maxChars: number | null; cost: number }

export const CONTENT_TIERS_KEY = "credit_cost.content_tiers"

const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0
const isNonNegInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0

/** 逐档消毒：形状/类型不合法即抛错（钱的输入不做「尽力而为」的回落）。 */
function parseOne(t: unknown, i: number): ContentTier {
  if (!t || typeof t !== "object") throw new Error(`计费阶梯第 ${i + 1} 档不是对象`)
  const { maxChars, cost } = t as Record<string, unknown>
  if (!isNonNegInt(cost)) throw new Error(`计费阶梯第 ${i + 1} 档 cost 必须是 ≥0 的整数`)
  if (maxChars !== null && !isPosInt(maxChars)) throw new Error(`计费阶梯第 ${i + 1} 档 maxChars 必须是正整数或 null`)
  return { maxChars: (maxChars ?? null) as number | null, cost }
}

/** 校验并规范化阶梯（纯函数）：返回按字数上限升序、顶档在末位的数组。
 *  任一条不满足即抛错——坏配置必须拒跑，静默免费或错价都是资损。 */
export function parseContentTiers(raw: unknown): ContentTier[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`计费阶梯未配置或为空：${CONTENT_TIERS_KEY}`)
  const tiers = raw.map(parseOne)
  const tops = tiers.filter((t) => t.maxChars === null)
  if (tops.length !== 1) throw new Error("计费阶梯必须有且只有一个顶档（maxChars=null）")
  const bounded = tiers
    .filter((t) => t.maxChars !== null)
    .sort((a, b) => (a.maxChars as number) - (b.maxChars as number))
  for (let i = 1; i < bounded.length; i++) {
    if (bounded[i]!.maxChars === bounded[i - 1]!.maxChars) throw new Error("计费阶梯的字数上限不可重复")
  }
  return [...bounded, tops[0]!]
}

/** 按总字数落档（纯函数）：升序取第一个满足 总字数 ≤ maxChars 的档，顶档兜底。
 *  前提：tiers 必须是 parseContentTiers 的输出（已保证有且只有一个顶档）。若循环走到
 *  末尾仍未命中，说明调用方传入的 tiers 没有顶档——这是违反前提的编程错误，必须报错，
 *  不能静默返回末档价格（那会在坏输入下悄悄算错钱，正是「缺口径即失败」要防的事故）。 */
export function costForChars(tiers: ContentTier[], totalChars: number): number {
  for (const t of tiers) if (t.maxChars === null || totalChars <= t.maxChars) return t.cost
  throw new Error("计费阶梯缺少顶档（maxChars=null），无法为该字数落档")
}

/** 预扣金额（纯函数）：取各档最大价。结算只多退不少补，取最大值可保证
 *  即使运营误配（中间档比顶档贵）也不会把结算算成少补而扣穿余额。 */
export function holdAmountFor(tiers: ContentTier[]): number {
  return Math.max(...tiers.map((t) => t.cost))
}

/** 结算金额（纯函数）：落档价钳到 ≤ 预扣额。这道 clamp 是防扣穿的最后一闸，
 *  也保证发版时「按旧价预扣的在途 run」能安全收尾（结算不会超过它已冻结的额度）。 */
export function settleAmountFor(tiers: ContentTier[], totalChars: number, heldAmount: number): number {
  return Math.min(costForChars(tiers, totalChars), heldAmount)
}

/** 阶梯「配置态」错误：口径缺失或非法，运营去后台改配置即可恢复。与基建故障（DB 连接重置/
 *  查询超时）严格分开——调用方只把这一类转 400 content_tiers_not_configured，基建故障照抛成
 *  5xx。否则一次数据库抖动会被报成「去配阶梯」，把排障引向根本没坏的配置。 */
export class ContentTiersConfigError extends Error {}

/** 读取运营配置的阶梯（IO）：缺失/非法一律抛 ContentTiersConfigError，由调用方转 400 拒跑；
 *  getConfig 自身的基建故障原样上抛，不伪装成配置问题。 */
export async function contentTiers(): Promise<ContentTier[]> {
  const raw = await getConfig(CONTENT_TIERS_KEY) // 基建故障（连接重置/超时）在此原样上抛
  try {
    return parseContentTiers(raw)
  } catch (e) {
    throw new ContentTiersConfigError(e instanceof Error ? e.message : String(e), { cause: e })
  }
}
