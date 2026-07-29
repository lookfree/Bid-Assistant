/** 章正文与提纲对齐归一化（与 agent 侧 render/sanitize.py 的 normalize_chapter_html 同一套
 *  规则，改语义须两侧同步）：正文里内嵌的是生成时的旧章标题/旧层级编号，用户改提纲或重排
 *  编号后必须以提纲现值为准——剥内嵌旧章级标题 + 小节层级编号首段跟随当前章号。
 *  确定性、宁留勿删/宁不动勿改错（规范形态下幂等）。 */
import { chapterOrdinal } from "@/lib/outline-edit"

const LEAD_HEADING = /^\s*<h([12])[^>]*>([\s\S]*?)<\/h\1>\s*/i
const STRONG_NO = /^第\s*[0-9〇零一二三四五六七八九十百]{1,3}\s*章/
const WEAK_NO = /^(?:[0-9]{1,2}(?![.．]?[0-9])[、.．\s]|[〇零一二三四五六七八九十]{1,3}[、.．])/
const HIER_PREFIX = /^[0-9]{1,2}[.．][0-9]/ // N.M 开头 = 子项级标题，绝不当章标题剥
const NO_PREFIX = /^(?:第\s*[0-9〇零一二三四五六七八九十百]{1,3}\s*章|[0-9]{1,2}(?![.．]?[0-9])[、.．\s]?|[〇零一二三四五六七八九十]{1,3}[、.．])\s*/
const HEADING_ANY = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi
const HIER_NO = /(<h[234][^>]*>\s*(?:<[^>]+>\s*)*)(\d{1,2})((?:[.．]\d{1,3})+)/gi
const BARE_NO_TEXT = /^[0-9]{1,2}[、\s]/ // 裸编号小节（"2 实施"）——存在即整章不改编号

const stripTags = (s: string) => s.replace(/<[^>]+>/g, "")
const collapse = (s: string) => s.replace(/\s+/g, "")

/** 剥正文首个 h1/h2 章级标题。判定（宁留勿删，全部条件缺一不可）：
 *  ① 不是子项级标题（N.M 开头绝不剥）；② 剩余部分没有同级或更高级标题（有并列小节 =
 *  普通小节标题，不是章级容器）；③ 语义命中之一：去编号前缀后与当前章标题**相等**
 *  （"包含"会误杀「售后服务体系」这类含章标题词的子项）／「第X章」强编号／弱编号且确有下级标题。 */
function dropLeadingChapterHeading(html: string, title: string): string {
  const m = LEAD_HEADING.exec(html)
  if (!m) return html
  const level = parseInt(m[1]!, 10)
  const raw = stripTags(m[2]!).trim()
  const rest = html.slice(m[0].length)
  if (HIER_PREFIX.test(raw)) return html
  const restHeadings = [...rest.matchAll(HEADING_ANY)]
  if (restHeadings.some((h) => parseInt(h[1]!, 10) <= level)) return html
  const wanted = collapse(title ?? "")
  if (wanted && collapse(raw.replace(NO_PREFIX, "")) === wanted) return rest
  if (STRONG_NO.test(raw)) return rest
  if (WEAK_NO.test(raw) && restHeadings.length > 0) return rest
  return html
}

/** h2-h4 层级编号（N.M…）首段改写为章号 n。先体检整章编号形态，两类情况一律不动
 *  （盲改会造出 7.1/7.1 重号或父子编号打架）：存在裸编号小节标题；层级编号首段不唯一。 */
function renumberHierHeadings(html: string, n: number): string {
  const firsts = new Set<string>()
  for (const hm of html.matchAll(HEADING_ANY)) {
    const level = parseInt(hm[1]!, 10)
    if (level < 2 || level > 4) continue
    const text = stripTags(hm[2]!).trim()
    const hier = /^(\d{1,2})[.．]\d/.exec(text)
    if (hier) firsts.add(hier[1]!)
    else if (BARE_NO_TEXT.test(text)) return html
  }
  if (firsts.size !== 1) return html
  return html.replace(HIER_NO, (_all, pre: string, _num: string, tail: string) => `${pre}${n}${tail}`)
}

/** 提纲内部 id 泄漏进标题（生产实测：写手把「t3.1」当编号抄进标题，导出与目录里全是 t2.3/t3.1）。
 *  只剥**本章自己的 id**、且其后必须紧跟点分/连字号数字——按 [tb]\d 通配去剥会把中文标书里
 *  极常见的「T3 航站楼」「B1 层车库」吃成「3 航站楼」「1 层车库」。与 sanitize.py 的
 *  _id_prefix_re 同一套规则，改语义须两侧同步。 */
function stripIdPrefix(html: string, chapterId: string): string {
  if (!/^[a-zA-Z]{1,2}[0-9]{1,3}$/.test(chapterId)) return html
  const digits = chapterId.replace(/[^0-9]/g, "")
  const re = new RegExp(`(<h[1-6][^>]*>\\s*(?:<[^>]+>\\s*)*)${chapterId}(?=[.\\-][0-9])`, "gi")
  return html.replace(re, (_all, pre: string) => `${pre}${digits}`)
}

/** 归一化入口：确定性；章号解析不出数字时层级编号不动。 */
export function normalizeChapterHtml(html: string, no: string, title: string, chapterId = ""): string {
  if (!html) return html
  const out = dropLeadingChapterHeading(stripIdPrefix(html, chapterId), title)
  const n = chapterOrdinal(no)
  return n === null ? out : renumberHierHeadings(out, n)
}
