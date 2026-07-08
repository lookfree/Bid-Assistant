"use client"

import { api } from "./api"
import { ApiError } from "./api-client"
import { tokenStore } from "./token-store"

// 全流程项目客户端（spec207）：一本标书一个 projectId/threadId，六步与 agent 节点序一致。
// 当前项目 id 存 localStorage（跨页贯穿：/read → /outline → … → /present）。

export type StepName = "read" | "outline" | "content" | "review" | "present" | "export"
export const STEP_ORDER: StepName[] = ["read", "outline", "content", "review", "present", "export"]

export type ProjectStep = { step: string; status: string; result: unknown; costPoints: number }
export type ProjectInfo = {
  // name：项目名（spec314 落库，取上传时原始文件名；老数据可能为 null，展示侧兜底"我的项目"）
  project: {
    id: string
    threadId: string
    name: string | null
    status: string
    currentStep: string
    tenderFileKey: string | null
  }
  steps: ProjectStep[]
}

const KEY = "bid.projectId"
const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080"

export function currentProjectId(): string | null {
  return typeof window === "undefined" ? null : localStorage.getItem(KEY)
}

/** 切换当前项目（项目列表页点卡片续作时调用），后续工具页经 localStorage 贯穿。 */
export function setCurrentProjectId(id: string): void {
  if (typeof window !== "undefined") localStorage.setItem(KEY, id)
}

/** 清除当前项目（本地 projectId 指向已删项目/404 时复位，工具页回到无项目引导态）。 */
export function clearCurrentProjectId(): void {
  if (typeof window !== "undefined") localStorage.removeItem(KEY)
}

// 项目列表行（GET /api/projects 契约，camelCase）
export type ProjectListItem = {
  id: string
  name: string
  status: "draft" | "running" | "done"
  currentStep: "read" | "outline" | "content" | "review" | "present" | "export" | "done"
  stepIndex: number
  totalSteps: number
  createdAt: string
}

export async function listProjects(
  page = 1,
  pageSize = 50,
): Promise<{ items: ProjectListItem[]; page: number; pageSize: number; total: number; hasMore: boolean }> {
  return api.request(`/api/projects?page=${page}&pageSize=${pageSize}`)
}

export async function createProject(fileKey: string): Promise<string> {
  const { id } = await api.request<{ id: string; threadId: string }>("/api/projects", {
    method: "POST",
    body: JSON.stringify({ fileKey }),
  })
  localStorage.setItem(KEY, id)
  return id
}

export async function getProject(id: string): Promise<ProjectInfo> {
  return api.request<ProjectInfo>(`/api/projects/${id}`)
}

// 已完成步的结果（camelCase，App 层已转）
export function stepResult<T>(info: ProjectInfo | null, step: StepName): T | null {
  const s = info?.steps.find((x) => x.step === step && x.status === "done")
  return (s?.result as T) ?? null
}

// 推进一步：POST SSE 流，进度分片回调 onChunk，结束解析 step.done 返回该步结果（camelCase）。
// body 为该步运行参数（present 步：{duration: 10|15|20, template: "blue"|"tech"|"gov"}），无参数步不传。
export async function runStep<T>(
  id: string,
  step: StepName,
  onChunk?: (text: string) => void,
  body?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${baseUrl}/api/projects/${id}/steps/${step}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tokenStore.get() ?? ""}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  // 错误码直通：402（积分不足）/ 409（步骤顺序）等抛 ApiError，供上层区分展示
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new ApiError(res.status, err.error)
  }
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    const text = dec.decode(value)
    buf += text
    onChunk?.(text)
  }
  // SSE 末尾的 step.done 事件带该步结果；失败（status=failed / 无 step.done）即抛错
  const m = [...buf.matchAll(/event:\s*step\.done\s*\ndata:\s*(.+)/g)].at(-1)
  if (!m) throw new Error(`step ${step} 未完成`)
  const payload = JSON.parse(m[1]!) as { status: string; result: T }
  if (payload.status !== "done") throw new Error(`step ${step} 失败`)
  return payload.result
}

// 步结果编辑回写：把编辑后的结果整份覆盖该步已完成的 result（outline/content/present）。
export async function patchStep(
  id: string,
  step: "outline" | "content" | "present",
  result: unknown,
): Promise<void> {
  await api.request<{ ok: boolean }>(`/api/projects/${id}/steps/${step}`, {
    method: "PATCH",
    body: JSON.stringify({ result }),
  })
}

// 单章 AI 改写（App 侧按 rewrite 口径计费 25 积分）：成功返回新正文 HTML（后端已合入 content 步结果）。
// 失败语义：402=余额不足、409=content 步未完成、502=agent 改写失败（均抛 ApiError）。
export async function rewriteChapter(
  id: string,
  chapterId: string,
  instruction: string,
): Promise<{ chapterId: string; html: string; cost: number }> {
  return api.request(`/api/projects/${id}/chapters/${chapterId}/rewrite`, {
    method: "POST",
    body: JSON.stringify({ instruction }),
  })
}

// 产物预签名下载 URL（docx/pptx），浏览器直下 MinIO。
export async function artifactUrl(id: string, kind: "docx" | "pptx"): Promise<string> {
  const { url } = await api.request<{ url: string }>(`/api/projects/${id}/artifacts/${kind}`)
  return url
}
