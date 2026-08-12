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
    // chapter = 招标出处（点回招标原文）；chapterTitle/anchorText = 标书侧位置（点回标书原文）。
    // 两个方向的定位字段必须都带上，混用会定位到错的文档（#97 实测）。
    riskItems: f.items.map((x) => ({
      level: x.level, tone: x.tone, title: x.title, chapter: x.tenderRef, advice: x.advice,
      chapterTitle: x.chapterTitle, anchorText: x.anchorText ?? "",
    })),
    passed: f.passedItems,
  }
}

/** 报告头部的扫描页提示：受审文件里**识别之后仍看不见**的内容有多少、都在哪几份文件里。
 *  pdf 按页数（pages）、docx 按内嵌图片张数（images，1a09214 加）分开计数，两者互不相加——
 *  「页」和「张」不是同一个口径，混在一起报数字会误导。
 *  null = 没有这样的内容（老报告没有这个字段、或全部识别成功）→ 横条不画，页面一如既往。
 *  这些内容没进过比对，基于它们的结论（尤其是「缺少某材料」）必须由人再看一眼。 */
export function scanNotice(f: RealRisk): { pages: number; images: number; files: ScannedFileStat[] } | null {
  const files = (f.scannedFiles ?? []).filter((x) => ("embeddedImages" in x ? x.embeddedImages > 0 : x.imagePages > 0))
  const pages = files.reduce((n, x) => n + ("embeddedImages" in x ? 0 : x.imagePages), 0)
  const images = files.reduce((n, x) => n + ("embeddedImages" in x ? x.embeddedImages : 0), 0)
  return pages > 0 || images > 0 ? { pages, images, files } : null
}

/** scanNotice 横条明细里单个文件的文案：pdf 报「看不见页数/总页数」，docx 报「内嵌图片张数」。 */
export function scanFileLabel(x: ScannedFileStat): string {
  return "embeddedImages" in x
    ? `《${x.name}》${x.embeddedImages} 张内嵌图片`
    : `《${x.name}》${x.imagePages}/${x.pages} 页`
}

/** /content 页体检条目：带定位目标（标书 tab 与章节 id），chapter 取标书章节名。 */
export type CheckItem = {
  level: string
  tone: "destructive" | "warning"
  title: string
  /** **标书**里的章节标题（跳转到本章修改用）。注意与 tenderRef 不是一回事。 */
  chapter: string
  /** **招标**出处（点回招标原文用）。混用过一次：把 chapter 当出处去定位招标原文，定位的是错东西。 */
  tenderRef: string
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
      tenderRef: x.tenderRef,
      advice: x.advice,
      targetTab: x.targetTab,
      targetId: x.targetId,
      anchorText: x.anchorText ?? "",
    })),
    passedItems: f.passedItems,
  }
}
