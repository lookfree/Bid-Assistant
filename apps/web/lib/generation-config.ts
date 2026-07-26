// 生成配置（spec330）：目标字数 + 输出格式。偏好存 localStorage（用户级,下次默认带出）;
// 格式键名与后端 zod 白名单/agent 渲染契约一致（snake_case 直传）。
export type DocFormat = {
  margin_cm?: { top?: number; bottom?: number; left?: number; right?: number }
  heading_font?: string
  heading_size?: string
  heading_bold?: boolean
  body_font?: string
  body_size?: string
  body_indent_chars?: 0 | 2
  line_spacing?: 1 | 1.5 | "fixed22"
}

export type GenerationConfig = { targetChars: number; format: DocFormat }

/** 默认格式（用户 2026-07-23 提供的口径,与 agent 渲染端 _FMT_DEFAULT 一致） */
export const DEFAULT_FORMAT: Required<Omit<DocFormat, "margin_cm">> & { margin_cm: Required<NonNullable<DocFormat["margin_cm"]>> } = {
  margin_cm: { top: 2.2, bottom: 2.2, left: 2.3, right: 2.3 },
  heading_font: "宋体",
  heading_size: "四号",
  heading_bold: true,
  body_font: "宋体",
  body_size: "小四",
  body_indent_chars: 2,
  line_spacing: 1.5,
}

export const TARGET_MIN = 10_000
export const TARGET_MAX = 500_000

// 初始字数经验换算（用户口径）：招标预算「一般一万元一页」，且非线性有下限——40万项目也要 70~80 页、
// 几百万起要几百页，故 页数 = max(下限, 预算万元数)；每页约 600 字（与 doc-stats CHARS_PER_PAGE 一致）。
const YUAN_PER_PAGE = 10_000
const PAGE_FLOOR = 80
const CHARS_PER_PAGE = 600

/** 解析招标预算自由文本 → 元；无法可靠解析返回 null（回退章数推荐，不瞎猜量级）。
 *  支持「600万」「¥6,000,000元」「1.2亿」「6,000,000」：去千分位/空白，识别万/亿单位；
 *  无单位且数字 ≥1万按元，过小/无数字 → null。 */
export function parseBudgetYuan(text: string | null | undefined): number | null {
  if (!text) return null
  const m = text.replace(/[,，\s]/g, "").match(/\d+(?:\.\d+)?/)
  if (!m) return null
  const n = Number(m[0])
  if (!Number.isFinite(n) || n <= 0) return null
  if (/亿/.test(text)) return n * 1e8
  if (/万/.test(text)) return n * 1e4
  return n >= 10_000 ? n : null
}

/** 多包件招标的字数基准（spec324）：一次只投一个包,标书篇幅应按「选中那个包」的限价估算,
 *  而非全招标总预算（projectMeta.budget＝各包之和）——否则选 98 万的包却按 279 万推荐,字数虚高。
 *  返回 {budget, fromPackage} 一处定夺（fromPackage 供文案区分「本包/招标」预算,勿在调用方另判一次,
 *  两处规则会漂移）。选中包限价「可解析」才用它；多包件下不可解析（面议/空）宁可回落章数推荐,
 *  也不拿各包之和的总预算估单包；单包/未选/陈旧 id 回落招标总预算。 */
export function budgetForSizing(
  tenderBudget: string | null | undefined,
  packages: { id: string; budget: string }[] | null | undefined,
  selectedPackageId: string | null | undefined,
): { budget: string | null | undefined; fromPackage: boolean } {
  const pkg = selectedPackageId ? packages?.find((p) => p.id === selectedPackageId) : undefined
  if (pkg && parseBudgetYuan(pkg.budget) != null) return { budget: pkg.budget, fromPackage: true }
  // 认得出是哪个包、但它的限价不可用 → 多包件时总预算必虚高,给 null 让上层回落章数推荐
  if (pkg && (packages?.length ?? 0) > 1) return { budget: null, fromPackage: false }
  return { budget: tenderBudget, fromPackage: false }
}

/** 初始推荐目标字数：优先按招标预算（一万元一页、下限约 80 页、每页 600 字）；预算不可解析时回退
 *  章节数 × 3000。夹在滑杆范围内（1万~50万）。budgetText 缺省 = 无预算信号。 */
export function suggestedTarget(chapterCount: number, budgetText?: string | null): number {
  const yuan = parseBudgetYuan(budgetText)
  const raw =
    yuan != null
      ? Math.max(PAGE_FLOOR, Math.round(yuan / YUAN_PER_PAGE)) * CHARS_PER_PAGE
      : chapterCount * 3000
  return Math.min(TARGET_MAX, Math.max(TARGET_MIN, raw))
}

// 字体/字号可选值：唯一权威在服务端 zod 白名单,此处为同步副本（勿单侧增删——只加这边会让
// localStorage 存下服务端必拒的值,导出恒 400）
export const FONT_OPTIONS = ["宋体", "仿宋", "楷体", "黑体"] as const
export const SIZE_OPTIONS = ["三号", "四号", "小四", "五号"] as const

const KEY = "bid.genConfig"

/** 存储形状：format 是**用户级**偏好（字体/页边距，换项目照用）；targetChars 则**按项目归属**，
 *  用 targetProjectId 标记它属于哪个项目——目标字数由该项目/包件的预算规模决定，不是用户偏好。 */
type StoredGenConfig = Partial<GenerationConfig> & { targetProjectId?: string | null }

export function loadGenConfig(): StoredGenConfig {
  if (typeof window === "undefined") return {}
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as StoredGenConfig
  } catch {
    return {}
  }
}

/** 存生成配置。projectId 标记 targetChars 的归属；不传（无项目）则该值对任何项目都不再复用。 */
export function saveGenConfig(cfg: GenerationConfig, projectId?: string | null): void {
  if (typeof window === "undefined") return
  localStorage.setItem(KEY, JSON.stringify({ ...cfg, targetProjectId: projectId ?? null }))
}

/** 取「本项目」上次选定的目标字数：仅当存的就是这个项目才返回。
 *  跨项目复用是错的——曾导致选了 98 万的包，滑杆却停在上个 425 万项目的 25.5万字，
 *  而下方说明文字同时写着「推荐 5.9万字」，两个数字自相矛盾。
 *  旧版本残留（有 targetChars 但无 targetProjectId）一律不复用，回落到按预算的推荐值。 */
export function storedTargetFor(projectId: string | null | undefined): number | undefined {
  if (!projectId) return undefined
  const c = loadGenConfig()
  if (c.targetProjectId !== projectId) return undefined
  return typeof c.targetChars === "number" && Number.isFinite(c.targetChars) ? c.targetChars : undefined
}

const clampMargin = (v: unknown, dflt: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(6, Math.max(0.5, v)) : dflt

/** 格式消毒（审查修正）：localStorage 可能残留清空/越界/旧版本值,原样发服务端会被 zod 400
 *  且用户无处修复——发送前逐项夹回合法域,非法枚举回落默认。 */
export function sanitizeFormat(f: DocFormat): DocFormat {
  const d = DEFAULT_FORMAT
  const m = f.margin_cm ?? {}
  return {
    margin_cm: {
      top: clampMargin(m.top, d.margin_cm.top),
      bottom: clampMargin(m.bottom, d.margin_cm.bottom),
      left: clampMargin(m.left, d.margin_cm.left),
      right: clampMargin(m.right, d.margin_cm.right),
    },
    heading_font: (FONT_OPTIONS as readonly string[]).includes(f.heading_font ?? "") ? f.heading_font : d.heading_font,
    heading_size: (SIZE_OPTIONS as readonly string[]).includes(f.heading_size ?? "") ? f.heading_size : d.heading_size,
    heading_bold: typeof f.heading_bold === "boolean" ? f.heading_bold : d.heading_bold,
    body_font: (FONT_OPTIONS as readonly string[]).includes(f.body_font ?? "") ? f.body_font : d.body_font,
    body_size: (SIZE_OPTIONS as readonly string[]).includes(f.body_size ?? "") ? f.body_size : d.body_size,
    body_indent_chars: f.body_indent_chars === 0 ? 0 : 2,
    line_spacing: f.line_spacing === 1 || f.line_spacing === "fixed22" ? f.line_spacing : 1.5,
  }
}

/** 导出时读存好的格式（未配置过返回 undefined → 请求不带 format,后端走现行样式）。 */
export function storedFormat(): DocFormat | undefined {
  const f = loadGenConfig().format
  return f && Object.keys(f).length > 0 ? sanitizeFormat(f) : undefined
}
