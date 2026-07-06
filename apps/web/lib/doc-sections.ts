// 招标原文分句展示工具（spec315a）：read 步 result.docSections = [{id,text}]，
// id 与 categories[].items[].clauseIds 同口径（形如 sec-1-c2）。分句本身无章节结构，
// 页面按 id 前缀（sec-N）分组渲染，并生成人类可读的定位提示。

export type DocSentence = { id: string; text: string }
export type DocSectionGroup = { id: string; title: string; paragraphs: DocSentence[] }

/** 按条款 id 前缀分组：sec-1-c2 → 组 sec-1（标题「第1部分」）；无 -cN 后缀的条目自成一组 */
export function groupDocSections(sentences: DocSentence[]): DocSectionGroup[] {
  const groups = new Map<string, DocSectionGroup>()
  for (const s of sentences) {
    const gid = s.id.replace(/-c\d+$/, "")
    let g = groups.get(gid)
    if (!g) {
      const n = /(\d+)$/.exec(gid)?.[1]
      g = { id: gid, title: n ? `第${n}部分` : gid, paragraphs: [] }
      groups.set(gid, g)
    }
    g.paragraphs.push(s)
  }
  return [...groups.values()]
}

/**
 * 条款定位提示（与示例数据 clauseLocation 同口径），基于传入的分组结构，
 * 真实 docSections 分组与示例 tenderDoc 通用。如「第二章 · 第2/3条」「第1部分 · 第2条」。
 */
export function clauseLocationIn(
  sections: { id: string; title: string }[],
  clauseIds?: string[],
): string {
  if (!clauseIds || clauseIds.length === 0) return ""
  const bySection = new Map<string, number[]>()
  for (const cid of clauseIds) {
    const m = /^(.*)-c(\d+)$/.exec(cid)
    if (!m) continue
    const [, secId, num] = m
    if (!bySection.has(secId)) bySection.set(secId, [])
    bySection.get(secId)!.push(Number(num))
  }
  const parts: string[] = []
  for (const [secId, nums] of bySection) {
    const sec = sections.find((s) => s.id === secId)
    const chap = sec ? sec.title.split(/\s+/)[0] : secId
    parts.push(`${chap} · 第${nums.sort((a, b) => a - b).join("/")}条`)
  }
  return parts.join("；")
}
