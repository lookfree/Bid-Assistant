import type { RiskReport } from "./bid-types"

// agent RiskReport（camelCase）：review 步结果。
// /risk 页与 /content 页废标体检共用（同一步、同一份结果），映射逻辑也集中在此。
export type RealRisk = RiskReport

/** /risk 页视图映射：总览计数 + 风险条目（chapter 取招标出处 tenderRef）。 */
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

/** /content 页体检条目：带定位目标（标书 tab 与章节 id），chapter 取标书章节名。 */
export type CheckItem = {
  level: string
  tone: "destructive" | "warning"
  title: string
  chapter: string
  advice: string
  targetTab: "tech" | "business"
  targetId: string
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
    })),
    passedItems: f.passedItems,
  }
}
