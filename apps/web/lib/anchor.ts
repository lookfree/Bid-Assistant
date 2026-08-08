/** 章内定位锚点匹配。
 *
 *  审查结果给的 anchor_text 是模型从正文里"原样摘抄"的一小段，但实际总有出入：
 *  喂给审查模型的章节是 **HTML**（review 节点只剥了内联图片），所以摘抄里可能夹着
 *  <strong>、<td> 这类标签；富文本里一个词会被拆进多个标签；空白与换行不一致；
 *  模型还会把半角括号写成全角、末尾自作主张补个句号。
 *  严格相等几乎必然匹配不上，于是白做一场——而且是静默的。
 */

/** 归一化：剥标签、去空白、全角标点转半角。只用于比较，不改变展示。 */
export function normalizeForMatch(text: string): string {
  return text
    .replace(/<[^>]*>/g, "") // 锚点可能是从章节 HTML 里摘的，带着标签
    .replace(/\s+/g, "")
    .replace(/[（］]/g, (c) => (c === "（" ? "(" : "]"))
    .replace(/[）]/g, ")")
    .replace(/[［]/g, "[")
    .replace(/[：]/g, ":")
    .replace(/[，]/g, ",")
    .replace(/[。；]/g, (c) => (c === "。" ? "." : ";"))
    .toLowerCase()
}

/** 锚点低于此长度就不做定位：两三个字会命中一堆无关段落，把用户带到更远的地方。 */
const MIN_PREFIX = 8
/** 提纲条目定位放宽到这个下限：条目标题去掉序号后常常只有六七个字（「企业财务报表」），
 *  按 8 字卡会让这类条目点了没反应。它比审查锚点安全——匹配的是小标题而非摘抄片段，
 *  且用户已经知道自己点的是哪一条，落在附近也是对的。 */
const MIN_ITEM_PREFIX = 4
/** 前缀兜底取多少字。按锚点长度的比例取是错的——模型常把整条要求都摘进锚点，
 *  而正文那一段只写了前半句，比例前缀照样比正文长、照样匹配不上。定长才稳。 */
const PREFIX_LEN = 12

/** 这段正文是不是原样包含锚点（归一化后）。 */
export function blockMatchesAnchor(blockText: string, anchor: string, minLen = MIN_PREFIX): boolean {
  const a = normalizeForMatch(anchor)
  if (a.length < minLen) return false // 锚点本身太短，不足以定位，交给调用方回落
  const b = normalizeForMatch(blockText)
  return !!b && b.includes(a)
}

/** 只按前缀命中（模型在末尾多写了几个字，甚至把整条要求都摘了进来）。 */
function matchesByPrefix(blockText: string, anchor: string): boolean {
  const a = normalizeForMatch(anchor)
  if (a.length <= PREFIX_LEN) return false
  const b = normalizeForMatch(blockText)
  return !!b && b.includes(a.slice(0, PREFIX_LEN))
}

/** 在若干段正文里找出锚点所在的下标；找不到返回 -1（调用方回落到章节顶部）。
 *
 *  两轮：先要求整段原样包含锚点；都没有才退到前缀。
 *  前缀命中**必须唯一**——12 个字很容易撞上同章里的套话开头（「投标人须具备下列资格条…」），
 *  而 find 只取文档序第一个，等于把用户带到一段不相干的地方还打上高亮，看着像是权威结论。
 *  宁可不定位：回落到章节顶部至少不误导。 */
export function findAnchorBlock(blocks: readonly string[], anchor: string, minLen = MIN_PREFIX): number {
  if (!anchor.trim()) return -1
  const exact = blocks.findIndex((t) => blockMatchesAnchor(t, anchor, minLen))
  if (exact >= 0) return exact
  const hits = blocks.reduce<number[]>((acc, t, i) => (matchesByPrefix(t, anchor) ? [...acc, i] : acc), [])
  return hits.length === 1 ? hits[0]! : -1
}

/** 按块查找而不是按文本节点：富文本会把一句话拆进 <strong>/<span> 等多个节点，
 *  逐节点匹配会因为跨节点而失败。段落/单元格/标题是自然的最小定位单位。 */
const BLOCK_SELECTOR = "p,td,th,li,h1,h2,h3,h4,h5,h6,blockquote"

/** 高亮存在多久（毫秒）。够看清是哪一段，又不至于一直留在文档里像是编辑痕迹。 */
const HIGHLIGHT_MS = 2400

/** 把锚点所在的那一段滚进视野并短暂高亮。
 *  返回是否定位成功——调用方据此决定要不要再等一帧重试（换章后编辑器要重新挂载）。 */
export function scrollToAnchor(root: HTMLElement | null, anchor: string, minLen = MIN_PREFIX): boolean {
  if (!root || !anchor.trim()) return false
  const blocks = Array.from(root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR))
  const i = findAnchorBlock(
    blocks.map((el) => el.textContent ?? ""),
    anchor,
    minLen,
  )
  if (i < 0) return false
  const hit = blocks[i]!
  hit.scrollIntoView({ block: "center", behavior: "smooth" })
  hit.classList.add("anchor-hit")
  setTimeout(() => hit.classList.remove("anchor-hit"), HIGHLIGHT_MS)
  return true
}


/** 序号前缀：「一、」「（一）」「1.1」「1、」「第三章」。 */
const ITEM_PREFIX = /^\s*(?:第?[一二三四五六七八九十百]+[章节、.．]|[（(][一二三四五六七八九十\d]+[)）]|\d+(?:[.．]\d+)*[、.．]?)\s*/
/** 尾部括注：「（附件2格式）」「（附件5-1）」。 */
const ITEM_SUFFIX = /[（(][^）)]*[)）]\s*$/

/** 提纲条目标签 → 用于章内定位的锚点：**去掉序号与尾部括注**。
 *
 *  提纲里的序号和正文里的序号经常对不上（提纲「一、法定代表人证明书」，正文写成
 *  「二、法定代表人证明书」），标签又常带「（附件2格式）」这种提纲独有的括注。
 *  2026-08-08 拿线上 943 个条目实测：直接拿标签匹配只有 84% 能定位，
 *  去掉序号与括注后到 96%——剩下的是模型压根没写那一节，回落章节顶部。 */
export function outlineItemAnchor(label: string): string {
  let s = label.trim()
  for (let i = 0; i < 3; i++) {
    const next = s.replace(ITEM_PREFIX, "").replace(ITEM_SUFFIX, "").trim()
    if (next === s) break
    s = next
  }
  return s
}

/** 提纲条目定位用的最小锚点长度（比审查锚点宽松，见 MIN_ITEM_PREFIX）。 */
export const ITEM_ANCHOR_MIN = MIN_ITEM_PREFIX
