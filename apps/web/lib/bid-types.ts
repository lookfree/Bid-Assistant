// 标书全流程共享数据形状（与 agent 输出契约 camelCase 同构），read/outline/risk 等页共用。
// 原 lib/sample-bid.ts 的示例数据已随「示例模式」一并删除，这里只保留类型定义。

/* ===================== 读标：评分办法表 ===================== */
export type ScoringRow = {
  id: string
  category: "技术方案" | "商务条款" | "投标报价"
  name: string
  score: number
  /** 是否★不可偏离项 */
  star?: boolean
  desc: string
  /** 招标原文条款 id（可多条） */
  clauseIds: string[]
  /** 对应标书章节 id */
  chapterId: string
}

/* ===================== 读标：分类解读条目 ===================== */
export type AnalysisItem = {
  title: string
  value: string
  /** 精确定位到的招标原文条款 id（可一条对多条）；missing 项为空 */
  clauseIds: string[]
  status: "found" | "missing"
  /** 是否废标风险点 */
  risk?: boolean
}

/* ===================== 读标：投标文件构成清单（spec321） ===================== */
export type StructureKind = "volume" | "chapter" | "form" | "rule"

export type StructureItem = {
  id: string
  title: string
  /** 分册 / 章节 / 表单 / 程序性要求（份数/密封/签章等） */
  kind: StructureKind
  required: boolean
  notes: string
  clauseIds: string[]
  sourceQuote: string
}

/* ===================== 读标：包件划分（spec324，多包件招标才有；单包标书为空） ===================== */
export type PackageInfo = {
  id: string
  name: string
  budget: string
  notes: string
  clauseIds: string[]
}

/* ===================== 提纲 / 正文章节 ===================== */
export type Group = "tech" | "business"
export type OutlineItem = { id: string; label: string; clauseIds?: string[]; isNew?: boolean }

export type BidChapter = {
  id: string
  no: string
  title: string
  group: Group
  /** 是否能在招标文件中索引到来源；false 表示提纲新增 */
  sourced: boolean
  /** 提纲子项 */
  items: OutlineItem[]
}

/* ===================== 审查：风险项（/risk 与 /content 体检共用） ===================== */
export type RiskFinding = {
  level: string
  tone: "destructive" | "warning"
  title: string
  /** 对应标书章节标题 */
  chapterTitle: string
  /** 对应招标条款（"对应：…"展示串） */
  tenderRef: string
  advice: string
  /** 定位目标：标书 tab 与章节 id */
  targetTab: Group
  targetId: string
}

/** review 步结果（agent RiskReport，camelCase）。 */
export type RiskReport = {
  score: number
  high: number
  mid: number
  passed: number
  items: RiskFinding[]
  passedItems: string[]
}


// 章节 HTML 防御清洗（e2e 实测）：模型可能把整章写成完整 HTML 文档,<style> 会泄漏劫持全页布局。
// agent 侧已在收稿处剥壳;这里兜底救已入库的旧数据(渲染前过一遍,幂等)。
export function stripDocumentShell(html: string): string {
  if (!html) return html
  return html
    .replace(/<head[\s>][\s\S]*?<\/head>/gi, "")
    .replace(/<style[\s>][\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s>][\s\S]*?<\/script>/gi, "")
    .replace(/<meta[^>]*>|<title[^>]*>[\s\S]*?<\/title>/gi, "")
    .replace(/<!DOCTYPE[^>]*>|<\/?(?:html|body)[^>]*>/gi, "")
    .trim()
}
