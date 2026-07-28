/** 排版感知的页数估算（spec330 补强）：按格式配置算版面容量，按 HTML 结构走查计行——
 *  表格行按行高计费（与字数无关）、标题带字号与段距、图片按固定高度，外加封面/目录/签章固定页。
 *  取代一刀切的"600 字/页"。
 *
 *  校准记录（2026-07-28,230 生产同一份实物标书,勿再各处另记口径）：
 *  - 密度：正文 countChars=98,821 字（12 章,688 表格行,表格占比典型）→ LibreOffice 实转 192 页
 *    （与线上 pdf_pages 同管道）⇒ BASE_DENSITY≈515 字/页；结构走查对该文档估 ~200 页（+4%,偏保守）。
 *  - 超写：用户目标 5.6 万字,生成完成时产出 ~7.9 万 ⇒ 1.4×（agent 侧 _OVERSHOOT_CALIBRATION;
 *    该文档后续经用户改写又长到 9.88 万,不计入超写口径）。
 *  后续用导出侧 pdf_pages 真实页数回报持续校准。 */
import type { DocFormat } from "@/lib/generation-config"

// GB 字号 → 磅值（与 agent render/docx.py _GB_PT 同口径,跨语言镜像不可免,改须两侧同步）
const GB_PT: Record<string, number> = { 三号: 16, 四号: 14, 小四: 12, 五号: 10.5 }
const CM_TO_PT = 28.3465
const A4_W = 21 * CM_TO_PT
const A4_H = 29.7 * CM_TO_PT

/** 默认排版（用户 2026-07-23 口径,agent _FMT_DEFAULT 镜像）。唯一权威定义在本模块——
 *  密度校准基线锚定它,generation-config 只 re-export（评审 F12:三份手抄本会单侧漂移）。 */
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

// CJK 单倍行高 ≈ 1.3 × 字号（Word 宋体实测口径）
const LINE_FACTOR = 1.3

/** 校准基线：默认排版下标书类文档的有效密度（字/页）,见文件头校准记录。 */
export const BASE_DENSITY = 515

type Fmt = Pick<DocFormat, "margin_cm" | "body_size" | "line_spacing" | "heading_size">

/** HTML → 纯文本字符数口径（doc-stats.countChars 复用本函数,评审 F13:两份拷贝会静默失同步）。 */
export function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, "")
}

function lineHeight(fontPt: number, spacing: DocFormat["line_spacing"]): number {
  const s = spacing ?? DEFAULT_FORMAT.line_spacing
  return s === "fixed22" ? 22 : fontPt * LINE_FACTOR * s
}

/** 版面容量：每行汉字数 × 每页行数（纯散文理论值,结构走查/密度缩放共用）。 */
export function pageCapacity(fmt?: Fmt): { charsPerLine: number; linesPerPage: number; bodyPt: number } {
  const m = fmt?.margin_cm ?? {}
  const d = DEFAULT_FORMAT.margin_cm
  const bodyPt = GB_PT[fmt?.body_size ?? DEFAULT_FORMAT.body_size] ?? 12
  const usableW = A4_W - ((m.left ?? d.left) + (m.right ?? d.right)) * CM_TO_PT
  const usableH = A4_H - ((m.top ?? d.top) + (m.bottom ?? d.bottom)) * CM_TO_PT
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

// 结构计费常数（用 230 真实 192 页文档校准）：标题段前后距、表格行内边距/边框、插图高度、
// 每章 H1、封面+签章;目录按标题数另计
const HEAD_EXTRA = 0.7
const ROW_PAD = 0.25
const IMG_LINES = 12
const CHAPTER_TITLE_LINES = 2.5
const FIXED_PAGES = 2

const OPEN_TOKEN = /<(\/?)(h[1-4]|p|li|tr|img)\b[^>]*>/gi
const CELL = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi

/** 线性分块（评审 F4:惰性回溯正则对未闭合标签是 O(未闭合数×长度),1MB 病态输入实测数百 ms 卡渲染线程）：
 *  一遍 token 扫描 + 每标签单调闭合指针配对,整体 O(n)。未闭合块不产出（其文本走覆盖率兜底按散文计）。 */
function walkBlocks(html: string): { tag: string; inner: string }[] {
  const tokens = [...html.matchAll(OPEN_TOKEN)]
  const closers: Record<string, number[]> = {}
  tokens.forEach((t, i) => {
    if (t[1] === "/") (closers[t[2]!.toLowerCase()] ??= []).push(i)
  })
  const ptr: Record<string, number> = {}
  const blocks: { tag: string; inner: string }[] = []
  let skipUntil = 0
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t[1] === "/" || t.index! < skipUntil) continue
    const tag = t[2]!.toLowerCase()
    if (tag === "img") {
      blocks.push({ tag, inner: "" })
      continue
    }
    const list = closers[tag] ?? []
    let p = ptr[tag] ?? 0
    while (p < list.length && tokens[list[p]!]!.index! < t.index! + t[0].length) p++
    ptr[tag] = p + 1
    if (p >= list.length) continue // 未闭合:跳过,文本由覆盖率兜底接住
    const closer = tokens[list[p]!]!
    blocks.push({ tag, inner: html.slice(t.index! + t[0].length, closer.index!) })
    skipUntil = closer.index! + closer[0].length
  }
  return blocks
}

/** 单块内容 → 行数成本。headingPt 用于 h1-h4（更大字号=每行更少字+段距）。
 *  嵌套在块内的 <img> 逐张计费（评审 F7:列表/单元格里插的证照图曾被整段吞掉）;
 *  空 <p>/<li>（Tiptap 连按回车的占位段）按 1 行计——导出渲染器会原样吐空段（评审 F8）。 */
function blockLines(tag: string, inner: string, cap: ReturnType<typeof pageCapacity>, headPt: number): { lines: number; headings: number } {
  const imgs = tag === "img" ? 1 : (inner.match(/<img\b/gi) ?? []).length
  const imgLines = imgs * IMG_LINES
  if (tag === "img") return { lines: imgLines, headings: 0 }
  if (tag === "tr") {
    const cells = [...inner.matchAll(CELL)].map((m) => stripTags(m[1] ?? ""))
    const per = Math.max(6, Math.floor(cap.charsPerLine / Math.max(1, cells.length)))
    const rows = Math.max(1, ...cells.map((c) => Math.ceil(c.length / per) || 1))
    return { lines: rows + ROW_PAD + imgLines, headings: 0 }
  }
  const chars = stripTags(inner).length
  if (tag.startsWith("h")) {
    if (!chars) return { lines: imgLines, headings: 0 }
    const perLine = Math.max(8, Math.floor((cap.charsPerLine * cap.bodyPt) / headPt))
    return { lines: Math.ceil(chars / perLine) * (headPt / cap.bodyPt) + HEAD_EXTRA + imgLines, headings: 1 }
  }
  // p/li：空块也占 1 行（docx 渲染器对每个 <p> 无条件 add_paragraph）
  return { lines: Math.max(1, Math.ceil(chars / cap.charsPerLine)) + imgLines, headings: 0 }
}

export type ChapterLines = { lines: number; headings: number }

/** 单章行数统计（不含章标题成本）——可按 html 引用缓存（chapter-nav 逐章缓存教训:
 *  MB 级文档每次渲染全量重算会烧满主线程）。空章返回 0。
 *  覆盖率兜底（评审 F2/F3/F9）：块走查没吃到的文本（裸文本/div 直挂/h5-h6/未闭合标签内容）
 *  按散文行补计——估算宁高勿漏;纯图片章不为 0。 */
export function estimateChapterLines(html: string, fmt?: Fmt): ChapterLines {
  if (!html) return { lines: 0, headings: 0 }
  const totalChars = stripTags(html).length
  if (totalChars === 0 && !/<img\b/i.test(html)) return { lines: 0, headings: 0 }
  const cap = pageCapacity(fmt)
  const headPt = GB_PT[fmt?.heading_size ?? DEFAULT_FORMAT.heading_size] ?? 14
  let lines = 0
  let headings = 0
  let covered = 0
  for (const b of walkBlocks(html)) {
    const r = blockLines(b.tag, b.inner, cap, headPt)
    lines += r.lines
    headings += r.headings
    covered += stripTags(b.inner).length
  }
  const uncovered = totalChars - covered
  if (uncovered > 0) lines += Math.ceil(uncovered / cap.charsPerLine)
  return { lines, headings }
}

/** 各章行数统计 → 全书页数（每非空章加一个章标题成本;fixedSections=false 不计封面/目录/签章——
 *  单章体量、技术标/商务标分栏等**局部**视图必须关掉,否则局部数字凭空多出全书固定页,评审 F9）。 */
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
