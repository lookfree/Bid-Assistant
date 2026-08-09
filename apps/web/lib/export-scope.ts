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

/** 某册的下载是否已过期（终审 C1）：exportedAt 早于最近一次内容变更 → 过期；键存在但查不到
 *  该册导出时刻（exportedAt 为 null）→ 保守当过期（宁可多一次确认，不可悄悄发旧文件）。
 *  未产出过该册（hasKey=false）不适用"过期"这个概念——调用方本就不会为它渲染下载按钮。
 *  用 Date 数值比较而非字符串比较：exportedAt 可能来自 agent（Python isoformat,"+00:00" 后缀）
 *  或数据库行 createdAt 兜底（JS toISOString,"Z" 后缀），两种后缀混着按字符串比不出正确大小。 */
export function volumeStale(exportedAt: string | null, contentChangedAt: string | null, hasKey: boolean): boolean {
  if (!hasKey || !contentChangedAt) return false
  if (!exportedAt) return true
  return new Date(exportedAt).getTime() < new Date(contentChangedAt).getTime()
}
