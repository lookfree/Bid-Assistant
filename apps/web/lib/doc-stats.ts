// 正文体量估算（字数 + 约合 A4 页数）。网页端是连续流式排版没有真实分页，
// 页数按标书常用排版口径（A4、宋体小四、1.5 倍行距 ≈ 600 字/页）估算，展示时须带"约"字。
const CHARS_PER_PAGE = 600

/** HTML 去标签、去实体、去空白后的正文字符数（中英文都按字符计）。 */
export function countChars(html: string): number {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, "").length
}

/** 估算 A4 页数：600 字/页向上取整；空内容为 0。 */
export function estimatePages(chars: number): number {
  return chars <= 0 ? 0 : Math.max(1, Math.ceil(chars / CHARS_PER_PAGE))
}

/** 字数展示：≥1 万显示「N.N万」，其余千分位。 */
export function fmtChars(chars: number): string {
  return chars >= 10000 ? `${(chars / 10000).toFixed(1)}万` : chars.toLocaleString("zh-CN")
}
