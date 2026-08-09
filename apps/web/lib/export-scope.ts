// 导出分册(技术标/商务标/全量) 纯函数（spec 2026-08-08-export-scope-design / plan 2026-08-09-export-scope）：
// 置灰判定与产物键映射，供 content 页导出弹窗（三选一 + 预告区）与下载调用共用。

export type ExportScope = "full" | "tech" | "business"

/** 各 scope 是否可选：tech 册要有 tech 章，business 册要有非 tech 章（未标组归商务，与后端同口径）。 */
export function scopeAvailability(chapters: { group?: string }[]): Record<ExportScope, boolean> {
  const tech = chapters.some((c) => c.group === "tech")
  const biz = chapters.some((c) => c.group !== "tech")
  return { full: chapters.length > 0, tech, business: biz }
}

/** scope → 产物键（docx/pdf/pdf_pages），与 agent 侧键后缀一致。 */
export function artifactKeys(scope: ExportScope): { docx: string; pdf: string; pdfPages: string } {
  const sfx = scope === "tech" ? "_tech" : scope === "business" ? "_biz" : ""
  return { docx: `docx${sfx}`, pdf: `pdf${sfx}`, pdfPages: `pdf_pages${sfx}` }
}
