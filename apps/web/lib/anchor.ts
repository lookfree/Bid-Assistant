/** 章内定位锚点匹配。
 *
 *  审查结果给的 anchor_text 是模型从正文里"原样摘抄"的一小段，但实际总有出入：
 *  富文本里一个词可能被拆进多个标签、空白与换行不一致、模型会把半角括号写成全角、
 *  末尾还常自作主张补个句号。严格相等几乎必然匹配不上，于是白做一场。
 *
 *  所以这里做归一化后的包含判断，再退一步用前缀匹配——宁可定位到同一段的开头，
 *  也好过退回章节顶部（那正是用户抱怨的"点哪条都跳同一个地方"）。
 */

/** 归一化：去掉所有空白，全角标点转半角。只用于比较，不改变展示。 */
export function normalizeForMatch(text: string): string {
  return text
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
/** 前缀兜底取多少字。按锚点长度的比例取是错的——模型常把整条要求都摘进锚点，
 *  而正文那一段只写了前半句，比例前缀照样比正文长、照样匹配不上。定长才稳。 */
const PREFIX_LEN = 12

/** 这段正文是不是锚点所指的那一处。 */
export function blockMatchesAnchor(blockText: string, anchor: string): boolean {
  const a = normalizeForMatch(anchor)
  if (a.length < MIN_PREFIX) return false // 锚点本身太短，不足以定位，交给调用方回落
  const b = normalizeForMatch(blockText)
  if (!b) return false
  if (b.includes(a)) return true
  // 前缀兜底：模型摘抄常在末尾多写几个字，甚至把整条要求都摘了进来
  return a.length > PREFIX_LEN && b.includes(a.slice(0, PREFIX_LEN))
}

/** 在若干段正文里找出锚点所在的下标；找不到返回 -1（调用方回落到章节顶部）。 */
export function findAnchorBlock(blocks: readonly string[], anchor: string): number {
  if (!anchor.trim()) return -1
  return blocks.findIndex((t) => blockMatchesAnchor(t, anchor))
}

/** 按块查找而不是按文本节点：富文本会把一句话拆进 <strong>/<span> 等多个节点，
 *  逐节点匹配会因为跨节点而失败。段落/单元格/标题是自然的最小定位单位。 */
const BLOCK_SELECTOR = "p,td,th,li,h1,h2,h3,h4,h5,h6,blockquote"

/** 高亮存在多久（毫秒）。够看清是哪一段，又不至于一直留在文档里像是编辑痕迹。 */
const HIGHLIGHT_MS = 2400

/** 把锚点所在的那一段滚进视野并短暂高亮。找不到就什么都不做——
 *  调用方此前已经把编辑器滚到顶部，保持那个结果比乱指一段好。 */
export function scrollToAnchor(root: HTMLElement | null, anchor: string): void {
  if (!root || !anchor.trim()) return
  const blocks = Array.from(root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR))
  const hit = blocks.find((el) => blockMatchesAnchor(el.textContent ?? "", anchor))
  if (!hit) return
  hit.scrollIntoView({ block: "center", behavior: "smooth" })
  hit.classList.add("anchor-hit")
  setTimeout(() => hit.classList.remove("anchor-hit"), HIGHLIGHT_MS)
}
