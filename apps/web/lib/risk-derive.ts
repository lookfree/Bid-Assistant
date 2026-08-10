import type { RiskReport, ScannedFileStat } from "./bid-types"

// agent RiskReport（camelCase）：review 步结果。
// /risk 页与 /content 页废标体检共用（同一步、同一份结果），映射逻辑也集中在此。
export type RealRisk = RiskReport

/** /risk 页视图映射：总览计数 + 风险条目（chapter 取招标出处 tenderRef）。
 *  2026-08-01 产品口径：整改建议对所有用户免费下发，原 adviceLocked 裁剪已移除。 */
export function deriveRisk(f: RealRisk) {
  return {
    score: f.score,
    overview: [
      { label: "高风险", value: f.high, tone: "destructive" },
      { label: "中风险", value: f.mid, tone: "warning" },
      { label: "已通过", value: f.passed, tone: "success" },
    ],
    riskItems: f.items.map((x) => ({ level: x.level, tone: x.tone, title: x.title, chapter: x.tenderRef, advice: x.advice })),
    passed: f.passedItems,
  }
}

/** 报告头部的扫描页提示：受审文件里**识别之后仍看不见**的页有多少、都在哪几份文件里。
 *  null = 没有这样的页（老报告没有这个字段、或扫描页全部识别成功）→ 横条不画，页面一如既往。
 *  这些页的内容没进过比对，基于它们的结论（尤其是「缺少某材料」）必须由人再看一眼。 */
export function scanNotice(f: RealRisk): { pages: number; files: ScannedFileStat[] } | null {
  const files = (f.scannedFiles ?? []).filter((x) => x.imagePages > 0)
  const pages = files.reduce((n, x) => n + x.imagePages, 0)
  return pages > 0 ? { pages, files } : null
}

/** /content 页体检条目：带定位目标（标书 tab 与章节 id），chapter 取标书章节名。 */
export type CheckItem = {
  level: string
  tone: "destructive" | "warning"
  title: string
  chapter: string
  advice: string
  targetTab: "tech" | "business"
  targetId: string
  /** 章内定位锚点（可能为空：老报告没有这个字段，缺失类问题也未必有可摘的原文） */
  anchorText: string
}

export type HealthReport = {
  score: number
  high: number
  mid: number
  passed: number
  items: CheckItem[]
  passedItems: string[]
}

/** /content 页「废标体检」视图映射：与 deriveRisk 同源，另带章节定位信息。 */
export function deriveHealthReport(f: RealRisk): HealthReport {
  return {
    score: f.score,
    high: f.high,
    mid: f.mid,
    passed: f.passed,
    items: f.items.map((x) => ({
      level: x.level,
      tone: x.tone,
      title: x.title,
      chapter: x.chapterTitle,
      advice: x.advice,
      targetTab: x.targetTab,
      targetId: x.targetId,
      anchorText: x.anchorText ?? "",
    })),
    passedItems: f.passedItems,
  }
}
