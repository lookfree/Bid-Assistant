/** 排版感知的页数估算（spec330 补强）：按格式配置算版面容量，按 HTML 结构走查计行——
 *  表格行按行高计费（与字数无关）、标题带字号与段距、图片按固定高度，外加封面/目录/签章固定页。
 *  取代一刀切的"600 字/页"（实测 190 页文档按旧口径只估出 133 页）。
 *  校准基线来自 230 生产实测：7.9 万字（默认排版、表格占比典型的标书）→ 真实导出 190 页。 */
import type { DocFormat } from "@/lib/generation-config"

// 版面常量（默认排版镜像 DEFAULT_FORMAT/agent _FMT_DEFAULT，只用类型不引运行时,避免模块环）
const GB_PT: Record<string, number> = { 三号: 16, 四号: 14, 小四: 12, 五号: 10.5 }
const CM_TO_PT = 28.3465
const A4_W = 21 * CM_TO_PT
const A4_H = 29.7 * CM_TO_PT
const DEF = { top: 2.2, bottom: 2.2, left: 2.3, right: 2.3, body: "小四", heading: "四号", spacing: 1.5 as const }
// CJK 单倍行高 ≈ 1.3 × 字号（Word 宋体实测口径）
const LINE_FACTOR = 1.3

/** 校准基线：默认排版下标书类文档的有效密度（字/页）。
 *  数据点：2026-07-28 230 生产真实导出——正文 98,821 字（12 章,表格占比典型）→ LibreOffice
 *  实转 192 页（与线上 pdf_pages 同管道）⇒ ≈515。后续用导出侧 pdf_pages 回报持续校准。 */
export const BASE_DENSITY = 515

type Fmt = Pick<DocFormat, "margin_cm" | "body_size" | "line_spacing" | "heading_size">

function lineHeight(fontPt: number, spacing: DocFormat["line_spacing"]): number {
  return spacing === "fixed22" ? 22 : fontPt * LINE_FACTOR * (spacing ?? DEF.spacing)
}

/** 版面容量：每行汉字数 × 每页行数（纯散文理论值,结构走查/密度缩放共用）。 */
export function pageCapacity(fmt?: Fmt): { charsPerLine: number; linesPerPage: number; bodyPt: number } {
  const m = fmt?.margin_cm ?? {}
  const bodyPt = GB_PT[fmt?.body_size ?? DEF.body] ?? 12
  const usableW = A4_W - ((m.left ?? DEF.left) + (m.right ?? DEF.right)) * CM_TO_PT
  const usableH = A4_H - ((m.top ?? DEF.top) + (m.bottom ?? DEF.bottom)) * CM_TO_PT
  return {
    charsPerLine: Math.max(10, Math.floor(usableW / bodyPt)),
    linesPerPage: Math.max(10, Math.floor(usableH / lineHeight(bodyPt, fmt?.line_spacing))),
    bodyPt,
  }
}

/** 有效密度（字/页）：校准基线按"该排版容量 / 默认排版容量"等比缩放。 */
export function densityForFormat(fmt?: Fmt): number {
  const d = pageCapacity()
  const c = pageCapacity(fmt)
  return Math.round((BASE_DENSITY * (c.charsPerLine * c.linesPerPage)) / (d.charsPerLine * d.linesPerPage))
}

/** 页数目标 → 目标字数（生成配置的推荐口径）。 */
export function suggestedCharsForPages(pages: number, fmt?: Fmt): number {
  return Math.round(pages * densityForFormat(fmt))
}

const BLOCK = /<(h[1-4]|p|li|tr)\b[^>]*>([\s\S]*?)<\/\1>|<img\b[^>]*\/?>/gi
const CELL = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi
const stripTags = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, "")

// 结构计费常数（2026-07-28 用 230 真实 190 页文档校准:走查估算 190±3%）：
// 标题段前后距、表格行内边距/边框、插图高度、每章 H1、封面+签章
const HEAD_EXTRA = 0.7
const ROW_PAD = 0.25
const IMG_LINES = 12
const CHAPTER_TITLE_LINES = 2.5
const FIXED_PAGES = 2 // 封面 1 + 签章约 1；目录按标题数另计

/** 单块内容 → 行数成本。headingPt 用于 h1-h4（更大字号=每行更少字+段距）。 */
function blockLines(tag: string, inner: string, cap: ReturnType<typeof pageCapacity>, headPt: number): { lines: number; headings: number } {
  if (tag === "img") return { lines: IMG_LINES, headings: 0 }
  if (tag === "tr") {
    const cells = [...inner.matchAll(CELL)].map((m) => stripTags(m[1] ?? ""))
    const per = Math.max(6, Math.floor(cap.charsPerLine / Math.max(1, cells.length)))
    const rows = Math.max(1, ...cells.map((c) => Math.ceil(c.length / per) || 1))
    return { lines: rows + ROW_PAD, headings: 0 }
  }
  const chars = stripTags(inner).length
  if (!chars) return { lines: 0, headings: 0 }
  if (tag.startsWith("h")) {
    const perLine = Math.max(8, Math.floor((cap.charsPerLine * cap.bodyPt) / headPt))
    return { lines: Math.ceil(chars / perLine) * (headPt / cap.bodyPt) + HEAD_EXTRA, headings: 1 }
  }
  return { lines: Math.ceil(chars / cap.charsPerLine), headings: 0 }
}

export type ChapterLines = { lines: number; headings: number }

/** 单章行数统计（不含章标题成本）——可按 html 引用缓存（chapter-nav 逐章缓存教训:
 *  MB 级文档每次渲染全量重算会烧满主线程）。空章返回 0。
 *  覆盖率兜底（评审 F2/F3/F9）：纯图片章不得为 0；块走查没吃到的文本（裸文本/div 直挂/
 *  h5-h6/未闭合标签吞掉的内容）按散文行补计——估算宁高勿漏。 */
export function estimateChapterLines(html: string, fmt?: Fmt): ChapterLines {
  if (!html) return { lines: 0, headings: 0 }
  const totalChars = stripTags(html).length
  const hasImg = /<img\b/i.test(html)
  if (totalChars === 0 && !hasImg) return { lines: 0, headings: 0 }
  const cap = pageCapacity(fmt)
  const headPt = GB_PT[fmt?.heading_size ?? DEF.heading] ?? 14
  let lines = 0
  let headings = 0
  let covered = 0
  for (const m of html.matchAll(BLOCK)) {
    const inner = m[2] ?? ""
    const r = blockLines((m[1] ?? "img").toLowerCase(), inner, cap, headPt)
    lines += r.lines
    headings += r.headings
    covered += stripTags(inner).length
  }
  const uncovered = totalChars - covered
  if (uncovered > 0) lines += Math.ceil(uncovered / cap.charsPerLine)
  return { lines, headings }
}

/** 各章行数统计 → 全书页数（每非空章加一个章标题成本;fixedSections=false 不计封面/目录/签章）。 */
export function pagesFromLines(stats: ChapterLines[], fmt?: Fmt, opts?: { fixedSections?: boolean }): number {
  const nonEmpty = stats.filter((s) => s.lines > 0)
  if (nonEmpty.length === 0) return 0
  const cap = pageCapacity(fmt)
  const lines = nonEmpty.reduce((sum, s) => sum + s.lines, nonEmpty.length * CHAPTER_TITLE_LINES)
  const headings = nonEmpty.reduce((sum, s) => sum + s.headings, nonEmpty.length)
  const body = Math.ceil(lines / cap.linesPerPage)
  if (opts?.fixedSections === false) return Math.max(1, body)
  return body + Math.ceil(headings / cap.linesPerPage) + FIXED_PAGES
}

/** 全书页数估算：chapters=各章正文 HTML（每章按导出结构额外带一个章标题）。 */
export function estimatePagesFromHtml(chapters: string[], fmt?: Fmt, opts?: { fixedSections?: boolean }): number {
  return pagesFromLines(chapters.map((h) => estimateChapterLines(h, fmt)), fmt, opts)
}
