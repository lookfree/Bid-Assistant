"use client"

import { api } from "./api"
import { ApiError } from "./api-client"
import { tokenStore } from "./token-store"

// 全流程项目客户端（spec207）：一本标书一个 projectId/threadId，六步与 agent 节点序一致。
// 当前项目 id 存 localStorage（跨页贯穿：/read → /outline → … → /present）。

export type StepName = "read" | "outline" | "content" | "review" | "present" | "export"
export const STEP_ORDER: StepName[] = ["read", "outline", "content", "review", "present", "export"]

/** SSE 直连流在收到 step.done 之前就断了（长步骤如 content 十多分钟，被代理/网络掐连接）。
 *  这不等于失败——服务端 run 与这条连接解耦，仍在跑/已跑完。调用方应转轮询收敛，别误报"生成失败"。 */
export class StreamIncompleteError extends Error {
  constructor(public step: StepName) {
    super(`step ${step} stream incomplete`)
    this.name = "StreamIncompleteError"
  }
}

/** 正文生成的逐章进度（agent 每写完一章推一条 chapter.progress SSE 事件，前端实时勾选）。 */
export type ChapterProgress = { kind?: string; done: number; total: number; doneIds: string[]; title?: string }

/** 步骤运行阶段（node/phase 事件 → 人话标签，如「读标·技术第2/5块」「审查中」）。 */
export type StepPhase = { label: string }
export type StepLiveEvent =
  | { kind: "chapter"; progress: ChapterProgress }
  | { kind: "phase"; phase: StepPhase }
  | { kind: "end" }

/** 订阅某步的实时进度事件流（只读、不计费）：任何步骤在跑时打开，从头回放持久事件，
 *  停留/切回/刷新都能立即接上进度。返回取消函数。无 running run → 立即结束。 */
export function openStepEvents(
  projectId: string,
  step: StepName,
  onEvent: (e: StepLiveEvent) => void,
): () => void {
  const ctrl = new AbortController()
  ;(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/projects/${projectId}/steps/${step}/events`, {
        headers: { authorization: `Bearer ${tokenStore.get() ?? ""}` },
        signal: ctrl.signal,
      })
      if (!res.ok || !res.body) return
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ""
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value)
        // 按 SSE 空行切帧，逐帧解析（event: <type>\ndata: <json>）；兼容 \r\n 分隔。
        const frames = buf.split(/\r?\n\r?\n/)
        buf = frames.pop() ?? ""
        for (const f of frames) {
          const type = /event:\s*(\S+)/.exec(f)?.[1]
          const dataM = /data:\s*(.+)/.exec(f)
          if (!type) continue
          if (type === "run.end") { onEvent({ kind: "end" }); return }
          if (!dataM) continue
          let d: unknown
          try { d = JSON.parse(dataM[1]!) } catch { continue }
          const data = (d as { data?: unknown }).data
          if (type === "progress" && (data as ChapterProgress)?.kind === "chapter") {
            onEvent({ kind: "chapter", progress: data as ChapterProgress })
          } else if (type === "progress" && (data as { kind?: string })?.kind === "phase") {
            onEvent({ kind: "phase", phase: { label: (data as { label: string }).label } })
          } else if (type === "progress" && (data as { kind?: string })?.kind === "heartbeat") {
            // 块内心跳：长块生成时 token 持续吐，附「已 N 字」让运行横幅动起来（不再看着卡住）。
            const hb = data as { label: string; chars?: number }
            const suffix = hb.chars ? `（已 ${hb.chars} 字）` : ""
            onEvent({ kind: "phase", phase: { label: `${hb.label}${suffix}` } })
          } else if (type === "node.start" || type === "step.done") {
            const node = (data as { node?: string })?.node
            if (node) onEvent({ kind: "phase", phase: { label: node } })
          }
        }
      }
    } catch { /* aborted / network：静默，页面降级为无实时进度 */ }
  })()
  return () => ctrl.abort()
}

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
    // 已选投标包件（spec324，多包件招标才有；单包/未选包为 null，outline 及之后步骤行为不变）
    selectedPackage: { id: string; name: string } | null
  }
  steps: ProjectStep[]
  // 同一招标文件的兄弟项目里已生成大纲的包 id（一包一份投标文件）：选包卡置灰不可再选；旧缓存可能缺省
  takenPackageIds?: string[]
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

export async function createProject(fileKeys: string[]): Promise<string> {
  const { id } = await api.request<{ id: string; threadId: string }>("/api/projects", {
    method: "POST",
    body: JSON.stringify({ fileKeys }),
  })
  localStorage.setItem(KEY, id)
  return id
}

// 短时内存缓存（模块级，跨工具页共享）：GET /:id 会带回全部步骤的 result（content 步 17 章 HTML，
// 单次不轻），切工具页（read→outline→content…）挂载时若已在 3s 内取过同一项目，直接复用，
// 减掉一次等价重取——TTL 短到用户感知不到数据陈旧，又能覆盖同一操作触发的多个工具页连续挂载。
// 正确性：仅缓存「无步骤在跑」的整份项目；一旦命中时发现有 running 行，视为未命中（断点续看轮询
// 需要看到最新状态）。任何 mutation（保存/选包/推进步骤）后显式失效，避免读到过期结果。
type ProjectCacheEntry = { info: ProjectInfo; ts: number }
// 30s:slim 项目状态只在用户操作(跑步骤/编辑/选包)时变化,各写路径均已主动失效缓存;
// 有步骤 running 时下方 getProject 恒视为未命中。长 TTL 让菜单来回切换零请求、无加载闪烁。
const PROJECT_CACHE_TTL_MS = 30_000
const projectCache = new Map<string, ProjectCacheEntry>()

/** 使某项目的缓存失效：mutation（PATCH 步结果 / 选包 / runStep）后调用，防止读到旧值。 */
export function invalidateProjectCache(id: string): void {
  projectCache.delete(id)
}

// 积分变动（任意步骤跑完，见 use-step.ts notifyCreditsChanged）意味着该项目步骤状态大概率已变，
// 整体清空比逐项目失效更简单也更安全（v1 用户量下清空成本可忽略）。
if (typeof window !== "undefined") {
  window.addEventListener("credits:refresh", () => projectCache.clear())
}

// 同步查看模块缓存（不发请求、不做「命中即排除 running」的过滤）：仅供页面挂载时做乐观初始渲染——
// 断点续看场景下让 running 初值直接来自缓存，避免先闪一下「尚未生成」占位再切成生成中。
// 真实状态仍由调用方紧接着发起的 getProject（effect 内）校准，这里只解决首帧视觉闪烁。
export function peekProjectCache(id: string): ProjectInfo | null {
  const hit = projectCache.get(id)
  return hit && Date.now() - hit.ts < PROJECT_CACHE_TTL_MS ? hit.info : null
}

export async function getProject(id: string, opts?: { fresh?: boolean }): Promise<ProjectInfo> {
  if (!opts?.fresh) {
    const hit = projectCache.get(id)
    // 命中但该项目当时有步骤在跑：不可信（断点续看轮询需要拿到最新状态），当未命中处理
    if (hit && Date.now() - hit.ts < PROJECT_CACHE_TTL_MS && !hit.info.steps.some((s) => s.status === "running")) {
      return hit.info
    }
  }
  // slim=1：不带各步 result 载荷（大标书 read result 可达 1MB，全量拉让每页首屏背 5s 传输税）。
  // 步骤状态毫秒级到手，页面立刻渲染正确状态；真有结果的步再走 fetchStepResult 按需拉取。
  const info = await api.request<ProjectInfo>(`/api/projects/${id}?slim=1`)
  projectCache.set(id, { info, ts: Date.now() })
  return info
}

/** 按需拉取单步结果（配合 slim 首屏）：该步无 done 结果时返回 null（404 语义）。 */
export async function fetchStepResult<T>(projectId: string, step: StepName): Promise<T | null> {
  try {
    const { result } = await api.request<{ result: T }>(`/api/projects/${projectId}/steps/${step}/result`)
    return result
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null
    throw e
  }
}

// 选包（spec324）：body 裸 {id,name} 设置该包，传 null 清除。只影响 outline 及之后步骤的 run_input
// （read 步/单包标书不受影响，与后端 PATCH /:id/package 契约一致——不用 {package:...} 包一层）。
export async function setProjectPackage(
  projectId: string,
  pkg: { id: string; name: string } | null,
): Promise<void> {
  await api.request(`/api/projects/${projectId}/package`, {
    method: "PATCH",
    body: JSON.stringify(pkg),
  })
  invalidateProjectCache(projectId)
}

// 克隆项目（spec324）：兼投多个包件=另建一个项目（同一招标文件，read 步重新跑）。
// pkg = 新项目投的包（多包流程建项即选包，名称带包名）；返回同 createProject 的 {id,threadId} 形状；
// 同样把新 id 落 localStorage，贯穿后续工具页。
export async function cloneProject(projectId: string, pkg?: { id: string; name: string }): Promise<string> {
  const { id } = await api.request<{ id: string; threadId: string }>(`/api/projects/${projectId}/clone`, {
    method: "POST",
    body: JSON.stringify(pkg ? { package: pkg } : {}),
  })
  localStorage.setItem(KEY, id)
  return id
}

// 已完成步的结果（camelCase，App 层已转）
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
    // 逐章/阶段进度不在这里解析：改由 openStepEvents 订阅 GET /events 事件流统一处理，
    // 停留、切回、刷新都能实时回放（本 POST 流仅用于拿 step.done 终态结果）。
  }
  // SSE 末尾的 step.done 事件带该步结果；失败（status=failed / 无 step.done）即抛错
  const m = [...buf.matchAll(/event:\s*step\.done\s*\ndata:\s*(.+)/g)].at(-1)
  // 没等到 step.done = 连接中途断开（长步骤常见），不是失败：抛可识别错误让上层转轮询收敛。
  if (!m) throw new StreamIncompleteError(step)
  const payload = JSON.parse(m[1]!) as { status: string; result: T; error?: string }
  if (payload.status !== "done") {
    // step.done 带 agent 侧失败原因（原始串不适合直接展示）：落 console 供排查，用户侧走通用失败文案
    console.error(`step ${step} failed:`, payload.error ?? "(no detail)")
    throw new Error(`step ${step} 失败`)
  }
  // 该项目步骤状态已变（新 done 行）：失效缓存，避免其他工具页挂载时读到跑之前的旧快照
  invalidateProjectCache(id)
  return payload.result
}

/** PATCH 步结果失败的用户可读文案：404 = 该步还没有真实生成结果（无 done 行），不可编辑保存。 */
export function patchErrorMessage(e: unknown): string {
  if (e instanceof ApiError && e.status === 404) return "该步骤还未生成，请先生成"
  return "保存失败，请重试"
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
  invalidateProjectCache(id)
}

// 单章 AI 改写（App 侧按 rewrite 口径计费 25 积分）：成功返回新正文 HTML（后端已合入 content 步结果）。
// 失败语义：402=余额不足、409=content 步未完成、502=agent 改写失败（均抛 ApiError）。
export async function rewriteChapter(
  id: string,
  chapterId: string,
  instruction: string,
): Promise<{ chapterId: string; html: string; cost: number }> {
  const result = await api.request<{ chapterId: string; html: string; cost: number }>(
    `/api/projects/${id}/chapters/${chapterId}/rewrite`,
    { method: "POST", body: JSON.stringify({ instruction }) },
  )
  invalidateProjectCache(id)
  return result
}

// 产物预签名下载（docx/pptx/pdf，pdf 为 spec323 best-effort 转换产物，可能不存在），浏览器直下 MinIO。
// filename = 服务端下发的下载名（带项目名），供「下载成功」提示点名具体文件。
export async function artifactDownload(
  id: string,
  kind: "docx" | "pptx" | "pdf",
): Promise<{ url: string; filename: string }> {
  return api.request<{ url: string; filename: string }>(`/api/projects/${id}/artifacts/${kind}`)
}

/** 触发浏览器下载：隐藏 <a> 点击。比 window.open 好在不闪空白标签页、await 之后也不被弹窗拦截。
 *  仅用于带 attachment disposition 的预签名 URL（服务端已带下载名），否则会把当前页导航走。 */
export function triggerDownload(url: string): void {
  const a = document.createElement("a")
  a.href = url
  a.rel = "noopener"
  document.body.appendChild(a)
  a.click()
  a.remove()
}
