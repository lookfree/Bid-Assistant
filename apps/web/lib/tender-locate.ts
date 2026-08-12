import { searchDocSections, type DocMatch, type DocSectionGroup } from "./doc-sections"

// 审查报告 →「招标出处」跳回招标原文。
//
// 每条风险都带一个 tenderRef，是模型**照抄**招标里的一句标题/条目名（如「第五章 技术规范书」）。
// 它一直只是屏幕上一行灰字：用户想核对「招标到底怎么要求的」，只能自己回读标页翻。
//
// 为什么按文字找而不是按编号：内部条款编号（sec-N-cM）只要出现在模型可见的文本里就会被抄进
// 结论交给用户——当初连提示词里「禁止输出 sec-8-c95」这个**反例本身**都被模仿了。所以引用
// 一律是人能读的标题文字，定位在前端用同一套全文搜索完成。

/** 跳转地址里承载定位词的查询参数。 */
export const LOCATE_PARAM = "locate"

// 太短的出处不给跳：「技术」「格式」这种两三个字全文到处都是，跳过去等于随机落点。
// 假装定位比不给定位更糟——用户会以为问题就出在落点那一处（同 report-dialog 里「无章可跳」的教训）。
const MIN_REF_CHARS = 4

// tenderRef 是**展示串**，契约写明模型要写成「对应：xxx（★不可偏离）」（schemas RiskFinding
// .tender_ref）。拿整串去全文搜必然一条都搜不到——招标原文里只有 xxx，没有「对应：」前缀，
// 于是「未能定位」横幅会在几乎每条上弹（评审 2026-08-12 实证）。搜之前先剥成 xxx。
const REF_PREFIX = /^\s*(?:对应|出处|依据)\s*[：:]\s*/
const REF_SUFFIX = /\s*[（(][^（）()]{0,20}[）)]\s*$/

/** 展示串 → 可用于全文搜索的名称。 */
export function refKeyword(tenderRef: string | undefined): string {
  return (tenderRef ?? "").replace(REF_PREFIX, "").replace(REF_SUFFIX, "").trim()
}

/** 出处 → 读标页地址；剥完太短/为空返回 null，调用方据此决定渲染成链接还是灰字。 */
export function tenderLocateHref(tenderRef: string | undefined): string | null {
  const ref = refKeyword(tenderRef)
  if (ref.length < MIN_REF_CHARS) return null
  return `/read?${LOCATE_PARAM}=${encodeURIComponent(ref)}`
}

/** 在已解析的招标原文里找落点。找不到返回 null——**不要退回第一条**：
 *  那会让用户以为招标要求就写在开头（report-dialog 实测过这个坑，63 条里 10 条假定位）。 */
export function pickLocateTarget(sections: DocSectionGroup[], ref: string): DocMatch | null {
  const q = refKeyword(ref)
  const hits = searchDocSections(sections, q)
  if (!hits.length) return null
  // 招标 PDF 开头几乎都有目录，把每个章名列一遍——按文档序取第一条就会落在目录行上，
  // 高亮给用户看的是一行光秃秃的目录，正是本文件开头说的那种「假定位」。
  // 章**标题**命中的那一节才是正主，优先取它。
  const byTitle = sections.find((sec) => sec.title.includes(q) || q.includes(sec.title))
  const titleHit = byTitle && hits.find((h) => h.secId === byTitle.id)
  return titleHit ?? hits[0]!
}

/** 从地址栏取定位词（读标页挂载时读一次）。 */
export function locateParamOf(search: string): string {
  return new URLSearchParams(search).get(LOCATE_PARAM)?.trim() ?? ""
}
