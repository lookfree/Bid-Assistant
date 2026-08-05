// 招标原文分句展示工具（spec315a）：read 步 result.docSections = [{id,text}]，
// id 与 categories[].items[].clauseIds 同口径（形如 sec-1-c2）。分句本身无章节结构，
// 页面按 id 前缀（sec-N）分组渲染，并生成人类可读的定位提示。

export type DocSentence = { id: string; text: string }
/** 解析器留下的章节标题：level 1=第N章/节/篇/部分，2=「一、」式顶层编号。 */
export type DocHeading = { sec: string; title: string; level?: number }
export type DocSectionGroup = { id: string; title: string; level: number; paragraphs: DocSentence[] }

/** 按条款 id 前缀分组：sec-1-c2 → 组 sec-1。
 *  标题优先用解析器留下的**原文标题**；拿不到（老结果 / 解析没识别出章节）才回落「第N部分」——
 *  那只是个占位，和文档里真正的章节名毫无关系。 */
export function groupDocSections(sentences: DocSentence[], headings: DocHeading[] = []): DocSectionGroup[] {
  const titleBySec = new Map(headings.map((h) => [h.sec, h]))
  const groups = new Map<string, DocSectionGroup>()
  for (const s of sentences) {
    const gid = s.id.replace(/-c\d+$/, "")
    let g = groups.get(gid)
    if (!g) {
      const h = titleBySec.get(gid)
      const n = /(\d+)$/.exec(gid)?.[1]
      g = { id: gid, title: h?.title ?? (n ? `第${n}部分` : gid), level: h?.level ?? 1, paragraphs: [] }
      groups.set(gid, g)
    }
    g.paragraphs.push(s)
  }
  return [...groups.values()]
}

/** 把升序条号折叠成区间段：[1,2,3,58,61,62,65] → ["1-3","58","61-62","65"]。 */
function collapseRuns(nums: number[]): string[] {
  const runs: string[] = []
  let start = nums[0]!
  let prev = nums[0]!
  for (const n of nums.slice(1)) {
    if (n === prev + 1) {
      prev = n
      continue
    }
    runs.push(start === prev ? `${start}` : `${start}-${prev}`)
    start = prev = n
  }
  runs.push(start === prev ? `${start}` : `${start}-${prev}`)
  return runs
}

// 零散区间段的展示上限：定位提示是导航标签不是全量清单，超限只列前几段 + 总处数
const MAX_RUNS_SHOWN = 4

/**
 * 条款定位提示（与示例数据 clauseLocation 同口径），基于传入的分组结构，
 * 真实 docSections 分组与示例 tenderDoc 通用。如「第二章 · 第2/3条」「第1部分 · 第2条」。
 * 条款很多时折叠：连续条号并成区间（第1-58/61-65条）；零散段超过 MAX_RUNS_SHOWN 再截断
 * （第1/3/5/7…条（共23处））——技术需求类条目可引用 60+ 条款，逐条罗列会把条目标题挤出可视区（生产实测）。
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
    const sorted = [...new Set(nums)].sort((a, b) => a - b)
    const runs = collapseRuns(sorted)
    const label = runs.length > MAX_RUNS_SHOWN
      ? `第${runs.slice(0, MAX_RUNS_SHOWN).join("/")}…条（共${sorted.length}处）`
      : `第${runs.join("/")}条`
    parts.push(`${chap} · ${label}`)
  }
  return parts.join("；")
}

/** 原文搜索的一处命中：条款 id + 所属分组 id（分组 id 用来切多文件页签）。 */
export type DocMatch = { clauseId: string; secId: string }

/** 正则元字符转义。用户搜的是条号（如 "3.6.2"）和带括号的中文（如 "（含税）"）——
 *  不转义的话 "." 会变成通配符匹配到 "3x6y2"，"*" 之类还会直接抛异常把整个搜索框搞崩。 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** 在原文里按关键词找命中条款，按文档顺序返回。
 *  标题也参与匹配：用户常常直接搜章节名，命中标题时定位到该章第一条。
 *  空/纯空白查询返回空——否则刚敲第一个字就全文命中，滚动条乱跳。 */
export function searchDocSections(sections: DocSectionGroup[], query: string): DocMatch[] {
  const q = query.trim()
  if (!q) return []
  const re = new RegExp(escapeRe(q), "i")
  const out: DocMatch[] = []
  for (const sec of sections) {
    const titleHit = re.test(sec.title)
    let sectionAdded = false
    for (const p of sec.paragraphs) {
      if (re.test(p.text)) {
        out.push({ clauseId: p.id, secId: sec.id })
        sectionAdded = true
      }
    }
    // 只命中标题（正文没有该词）时，给该章第一条作为落点
    if (titleHit && !sectionAdded && sec.paragraphs.length > 0) {
      out.push({ clauseId: sec.paragraphs[0]!.id, secId: sec.id })
    }
  }
  return out
}

/** 把一段文字按关键词切成交替片段，供高亮渲染。命中片保留原文大小写。 */
export function splitByQuery(text: string, query: string): { text: string; hit: boolean }[] {
  const q = query.trim()
  if (!q) return [{ text, hit: false }]
  const parts: { text: string; hit: boolean }[] = []
  const re = new RegExp(escapeRe(q), "gi")
  let last = 0
  for (const m of text.matchAll(re)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), hit: false })
    parts.push({ text: m[0], hit: true })
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last), hit: false })
  return parts.length ? parts : [{ text, hit: false }]
}
