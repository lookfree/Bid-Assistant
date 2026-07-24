import { api, type RequestFn } from "./api"

// 标书查重 + 终极审核表接口封装（spec315b Web 侧契约），全部建在 api.request 上。
// 工厂形式（照 library-api.ts 模式）：createRiskApi(request) 便于测试注入 fetchImpl，
// 模块底部导出绑定单例与具名函数，页面直接 import 使用。

/* ---------------- 标书查重 POST /api/dedupe ---------------- */

export type DedupeDim = "text" | "image" | "meta" | "baseline"
export type DedupeStrategy = "fast" | "standard" | "strict"

export type DedupeHit = {
  dim: DedupeDim
  aText?: string
  bText?: string
  detail: string
}

export type DedupePair = {
  a: string
  b: string
  /** 相似度 0-100 */
  score: number
  tone: "destructive" | "warning" | "success"
  note: string
  hits: DedupeHit[]
}

export type DedupeResult = {
  pairs: DedupePair[]
  overall: { maxScore: number; highPairs: number }
  dimsRun: DedupeDim[]
}

/* ---------------- 终极审核表 GET/PUT /api/checklist ---------------- */

export type CheckStatus = "pass" | "risk" | "pending"

/** 单项持久化状态，键为 "组id-序号"（如 "A-0"）。 */
export type ChecklistItemState = { status: CheckStatus; owner: string; note: string }

/** 审核表分组定义（spec333）：与前端默认模板同构；template 由读标结论定制生成，null 则用默认 36。 */
export type ChecklistGroupDef = { id: string; title: string; items: string[] }

export type ChecklistExportGroup = {
  id: string
  title: string
  items: { text: string; status: CheckStatus; owner: string; note: string; libraryHit: string | null }[]
}

export function createRiskApi(request: RequestFn) {
  return {
    /** 发起查重（计费点在后端：hold "dedupe" → settle）。402 积分不足 / 400 invalid_files / 422 解析失败 / 502 agent_failed。 */
    runDedupe: (body: { fileKeys: string[]; tenderKey?: string; dims: DedupeDim[]; strategy: DedupeStrategy }) =>
      request<DedupeResult>("/api/dedupe", { method: "POST", body: JSON.stringify(body) }),

    getChecklist: (
      projectId: string | null,
    ): Promise<{ items: Record<string, ChecklistItemState>; template: ChecklistGroupDef[] | null }> =>
      request(`/api/checklist${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),

    saveChecklist: (projectId: string | null, items: Record<string, ChecklistItemState>): Promise<{ ok: boolean }> =>
      request("/api/checklist", {
        method: "PUT",
        body: JSON.stringify({ ...(projectId ? { projectId } : {}), items }),
      }),

    /** 导出签字版审核表（计费点在后端：hold "export" → settle）。402 积分不足 / 502 agent_failed。 */
    exportChecklist: (body: { projectId?: string; title?: string; groups: ChecklistExportGroup[] }) =>
      request<{ url: string; cost: number }>("/api/checklist/export", { method: "POST", body: JSON.stringify(body) }),

    /** 导出标书分析报告（免计费——读标步已收费）：服务端取存量 read 结果渲染 docx。 */
    exportReadReport: (projectId: string) =>
      request<{ url: string; filename: string }>("/api/checklist/report/read", {
        method: "POST",
        body: JSON.stringify({ projectId }),
      }),

    /** 导出废标体检报告（免计费——体检 review 步已收费）。format=pdf 为 best-effort，
     *  转换失败回落 docx（返回的 format/filename 如实反映实际产物）。 */
    exportRiskReport: (body: {
      projectName?: string
      score?: number
      high: number
      mid: number
      passed: number
      items: { level: string; title: string; chapter: string; advice: string }[]
      passedItems: string[]
      format: "docx" | "pdf"
    }) =>
      request<{ url: string; filename: string; format: "docx" | "pdf" }>("/api/checklist/report", {
        method: "POST",
        body: JSON.stringify(body),
      }),
  }
}

export const riskApi = createRiskApi(api.request)
export const { runDedupe, getChecklist, saveChecklist, exportChecklist, exportRiskReport, exportReadReport } = riskApi
