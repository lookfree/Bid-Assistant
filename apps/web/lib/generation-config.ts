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

export function loadGenConfig(): Partial<GenerationConfig> {
  if (typeof window === "undefined") return {}
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<GenerationConfig>
  } catch {
    return {}
  }
}

export function saveGenConfig(cfg: GenerationConfig): void {
  if (typeof window !== "undefined") localStorage.setItem(KEY, JSON.stringify(cfg))
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
