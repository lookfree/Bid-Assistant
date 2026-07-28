// 正文体量估算（字数 + 约合 A4 页数）。网页端是连续流式排版没有真实分页，展示时须带"约"字。
// 密度用 page-estimate 的校准基线（515 字/页,校准记录见其文件头）;
// 有 HTML 结构时优先用 estimatePagesFromHtml（表格/标题按行高计费,更准）。
import { BASE_DENSITY, stripTags } from "@/lib/page-estimate"

/** HTML 去标签、去实体、去空白后的正文字符数（中英文都按字符计）。
 *  口径与 page-estimate.stripTags 同源（评审 F13:密度校准以本口径计字,两份拷贝会静默失同步）。 */
export function countChars(html: string): number {
  return stripTags(html).length
}

/** 估算 A4 页数（纯字数快速口径,无结构信息时用）：校准密度向上取整；空内容为 0。 */
export function estimatePages(chars: number): number {
  return chars <= 0 ? 0 : Math.max(1, Math.ceil(chars / BASE_DENSITY))
}

/** 字数展示：≥1 万显示「N.N万」，其余千分位。 */
export function fmtChars(chars: number): string {
  return chars >= 10000 ? `${(chars / 10000).toFixed(1)}万` : chars.toLocaleString("zh-CN")
}
