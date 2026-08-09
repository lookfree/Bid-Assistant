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

/** 该步确实失败了，且服务端给出了**可以直接展示给用户**的原因。
 *
 *  detail 只在服务端认定该原因适合外露时才有（见 api 侧 userFacingRunError：只放行我们自己写的
 *  RuntimeError 文案，代码 bug 的原始异常不外露）。有 detail 就该原样展示——像「扫描件解析不出
 *  文字」这种重试多少次都不会变的失败，笼统说「请重试」等于让用户白点：2026-08-07 实测，一份
 *  盖章扫描件在 1 分钟内被重试了 21 次。 */
export class StepFailedError extends Error {
  constructor(
    public step: StepName,
    public detail?: string,
  ) {
    super(detail || `step ${step} 失败`)
    this.name = "StepFailedError"
  }
}

/** 正文生成的逐章进度（agent 每写完一章推一条 chapter.progress SSE 事件，前端实时勾选）。 */
export type ChapterProgress = { kind?: string; done: number; total: number; doneIds: string[]; title?: string }

/** 步骤运行阶段（node/phase 事件 → 人话标签，如「读标·技术第2/5块」「审查中」）。 */
export type StepPhase = { label: string }
import type { DocHeading } from "./doc-sections"

export type StepLiveEvent =
  | { kind: "chapter"; progress: ChapterProgress }
  | { kind: "phase"; phase: StepPhase }
  | { kind: "readPart"; part: Record<string, unknown> }
  | { kind: "readSections"; sections: { id: string; text: string }[]; headings?: DocHeading[] }
  // 重连即将从流首整份回放：消费方必须先清空累加的展示态，否则条款/分轮条目会叠两遍
  | { kind: "reset" }
  | { kind: "end" }

// 重连节奏。首连必然扑空：订阅由 start() 的 setRunning(true) 触发，比 POST 建 run 早约 1 秒
// （要先扣费再向 agent 建 run 才回填 runId），服务端查不到 runId 就发 idle 关流——不重连的话
// 整轮进度事件全丢在 Redis 里没人接（生产实测：读标 6 分钟只见兜底文案，407 条事件一条没到）。
// 也顺带自愈中途断连（发版重启/代理超时）。上限 ~60s：run 一直起不来（如扣费失败）就安静降级。
const EVENTS_RETRY_MS = 1000
const EVENTS_MAX_TRIES = 60

/** 订阅某步的实时进度事件流（只读、不计费）：任何步骤在跑时打开，从头回放持久事件，
 *  停留/切回/刷新都能立即接上进度。返回取消函数。
 *  连不上/run 还没建好/中途断开都会自动重连——事件流是 Redis Stream 从头回放的，重连不丢事件。 */
export function openStepEvents(
  projectId: string,
  step: StepName,
  onEvent: (e: StepLiveEvent) => void,
): () => void {
  const ctrl = new AbortController()
  ;(async () => {
    for (let tries = 0; tries < EVENTS_MAX_TRIES; tries++) {
      if (ctrl.signal.aborted) return
      // 重连前让消费方清空：本次连接会把已发生的事件从头再放一遍
      if (tries > 0) onEvent({ kind: "reset" })
      if (await pumpStepEvents(projectId, step, onEvent, ctrl.signal)) return // 收到 run.end：本步已结束
      if (ctrl.signal.aborted) return
      await new Promise((r) => setTimeout(r, EVENTS_RETRY_MS))
    }
  })()
  return () => ctrl.abort()
}

/** 单次连接：把一条 SSE 事件流读到底并逐帧派发。收到 run.end 返回 true（本步结束，无须重连）；
 *  连接失败/服务端发 idle/流被掐断都返回 false（由调用方重连）。 */
async function pumpStepEvents(
  projectId: string,
  step: StepName,
  onEvent: (e: StepLiveEvent) => void,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/steps/${step}/events`, {
      headers: { authorization: `Bearer ${tokenStore.get() ?? ""}` },
      signal,
    })
    if (!res.ok || !res.body) return false
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ""
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return false
      // stream: true 不可省——多字节汉字被网络分片切断时，逐片当完整流解码会把
      // 半个字符替换成 U+FFFD。JSON 仍能解析（U+FFFD 在字符串里合法），于是**静默乱码**。
      buf += dec.decode(value, { stream: true })
      // 按 SSE 空行切帧，逐帧解析（event: <type>\ndata: <json>）；兼容 \r\n 分隔。
      const frames = buf.split(/\r?\n\r?\n/)
      buf = frames.pop() ?? ""
      for (const f of frames) {
        if (dispatchStepFrame(f, onEvent)) { onEvent({ kind: "end" }); return true }
      }
    }
  } catch {
    return false // aborted / network：由调用方决定重连或退出
  }
}

/** 解析一帧 SSE 并派发为 StepLiveEvent；该帧是 run.end 时返回 true。 */
function dispatchStepFrame(f: string, onEvent: (e: StepLiveEvent) => void): boolean {
  const type = /event:\s*(\S+)/.exec(f)?.[1]
  const dataM = /data:\s*(.+)/.exec(f)
  if (!type) return false
  if (type === "run.end") return true
  if (!dataM) return false
  let d: unknown
  try { d = JSON.parse(dataM[1]!) } catch { return false }
  const data = (d as { data?: unknown }).data
  const kind = (data as { kind?: string })?.kind
  if (type === "progress" && kind === "chapter") {
    onEvent({ kind: "chapter", progress: data as ChapterProgress })
  } else if (type === "progress" && kind === "phase") {
    onEvent({ kind: "phase", phase: { label: (data as { label: string }).label } })
  } else if (type === "progress" && kind === "read_part") {
    // 分段读标每完成一轮推一条：整轮跑完前先把已解读的部分放上屏（大标书要十几分钟）。
    // 这是**展示态**，最终以 step.done 的合并结果整体覆盖——前端不复刻服务端的合并语义。
    onEvent({ kind: "readPart", part: (data as { part: Record<string, unknown> }).part })
  } else if (type === "progress" && kind === "read_sections") {
    // 招标原文分片：条款在模型跑之前就解析好了，先推给左栏——不然半个屏幕空等十几分钟，
    // 右栏流式出来的条目也点不动（点条款定位原文靠的就是左栏）。
    onEvent({
      kind: "readSections",
      sections: (data as { sections: { id: string; text: string }[] }).sections,
      headings: (data as { headings?: DocHeading[] }).headings,
    })
  } else if (type === "progress" && kind === "heartbeat") {
    // 块内心跳：长块生成时 token 持续吐，附「已 N 字」让运行横幅动起来（不再看着卡住）。
    const hb = data as { label: string; chars?: number }
    const suffix = hb.chars ? `（已 ${hb.chars} 字）` : ""
    onEvent({ kind: "phase", phase: { label: `${hb.label}${suffix}` } })
  } else if (type === "node.start" || type === "step.done") {
    const node = (data as { node?: string })?.node
    if (node) onEvent({ kind: "phase", phase: { label: node } })
  }
  return false
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
    kind?: "bid" | "review" // spec328：审查专用项目（工具页据此改导航,不进生成流水线）
    // 已选投标包件（spec324，多包件招标才有；单包/未选包为 null，outline 及之后步骤行为不变）
    selectedPackage: { id: string; name: string } | null
    // 导出计费脏标记（2026-07-31 口径）：内容改过 → 下次导出收费；未改动 → 重复下载免费。
    // 前端据此决定要不要设余额门与显示费用；老接口没这个字段时按收费处理（保守，不会误显示免费）。
    exportDirty?: boolean
    // 标书分类**用户确认值**（spec334）。三态：null/缺省=没表态（回落系统判定值）；
    // 非空数组=用户选定（首元素为主类别）；**空数组=用户明确不用分类**。
    bidCategory?: BidCategoryValue[] | null
  }
  steps: ProjectStep[]
  // 同一招标文件的兄弟项目里已生成大纲的包 id（一包一份投标文件）：选包卡置灰不可再选；旧缓存可能缺省
  takenPackageIds?: string[]
  // 系统判定值（含置信度与证据条款）：前端据此把「系统判定 / 你已改判」两态说清楚。
  // 只有非 slim 的详情才回；slim 回的是已生效的 effectiveCategory。
  detectedCategory?: DetectedCategory | null
  effectiveCategory?: BidCategoryValue[]
}

// 标书分类（spec334）：《政府采购法》的货物/服务/工程三分法。**注意别和 content 页的 `bidType`
// （技术标/商务标/全文）混为一谈**，那是另一个维度。
export const BID_CATEGORIES = ["goods", "services", "engineering"] as const
export type BidCategoryValue = (typeof BID_CATEGORIES)[number]
export const BID_CATEGORY_LABEL: Record<BidCategoryValue, string> = {
  goods: "货物标",
  services: "服务标",
  engineering: "工程标",
}
export type DetectedCategory = {
  value: BidCategoryValue[]
  confidence?: string
  reason?: string
  evidenceClauseIds?: string[]
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
  kind?: "bid" | "review" // spec328：审查专用项目前端按此路由 /risk（旧缓存可能缺省）
  currentStep: "read" | "outline" | "content" | "review" | "present" | "export" | "done"
  stepIndex: number
  totalSteps: number
  /** 招标文件份数（正文+补遗+答疑+清单常是多份）：列表展示「主文件名 · 含 N 份」 */
  tenderCount?: number
  /** 已有可用的投标文件（生成到正文之后，或线下上传的标书）：述标/审查选择列表据此过滤 */
  hasBid?: boolean
  /** 已完成的步（read/outline/content/review/present/export）：列表据此标「已审查 / 已述标」——
   *  只看 currentStep 会标错，审查跑完 currentStep 就走到 present 了 */
  doneSteps?: string[]
  /** 本次生效的标书分类（spec334，确认值 ?? 判定值）；空数组=未判定或用户关掉 */
  bidCategory?: BidCategoryValue[]
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
/** 独立审查建项（spec328）：线下标书必传,招标文件可选（附了先读标做对照审查）。返回项目 id。 */
/** 线下标书建项：两侧都收多文件（商务标/技术标常分册出卷；招标文件常带补遗与答疑）。
 *  数组顺序 = agent 解析拼接顺序，别在这里排序。 */
export async function createReviewProject(bidFileKeys: string[], tenderFileKeys: string[] = []): Promise<string> {
  const { id } = await api.request<{ id: string; threadId: string }>("/api/projects/review", {
    method: "POST",
    body: JSON.stringify({ bidFileKeys, ...(tenderFileKeys.length ? { tenderFileKeys } : {}) }),
  })
  return id
}

/** 删除标书（生成中的后端 409 project_running 拒删）；删的是当前项目则顺带清本地指向。 */
export async function deleteProject(projectId: string): Promise<void> {
  await api.request(`/api/projects/${projectId}`, { method: "DELETE" })
  if (currentProjectId() === projectId) clearCurrentProjectId()
}

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
    // stream: true 同上。这条流带的是 step.done 的最终结果（大标书可达 1MB 中文），
    // 少了它，被分片切断的汉字会变成 U+FFFD 混进解读内容里——JSON 照样解析得开，静默乱码。
    const text = dec.decode(value, { stream: true })
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
    // 服务端只在原因适合外露时才带 error（见 api 侧 userFacingRunError）；带了就原样展示，
    // 没带才回落通用文案。console 仍留一份供排查。
    console.error(`step ${step} failed:`, payload.error ?? "(no detail)")
    throw new StepFailedError(step, payload.error)
  }
  // 该项目步骤状态已变（新 done 行）：失效缓存，避免其他工具页挂载时读到跑之前的旧快照
  invalidateProjectCache(id)
  return payload.result
}

/** 述标预览图：present 步渲染的逐页真实 PPT 位图，按页序返回预签名地址。
 *  没有（老项目 / 本次渲染失败）时回空数组——那不是错误，前端回落到 CSS 预览。 */
export async function deckPreviews(id: string): Promise<string[]> {
  const r = await api.request<{ urls: string[] }>(`/api/projects/${id}/deck-previews`)
  return r.urls ?? []
}

/** PATCH 步结果失败的用户可读文案：404 = 该步还没有真实生成结果（无 done 行），不可编辑保存。 */
export function patchErrorMessage(e: unknown): string {
  if (e instanceof ApiError && e.status === 404) return "该步骤还未生成，请先生成"
  // AbortSignal.timeout 抛的是 DOMException(name=TimeoutError)。笼统说「保存失败」会让用户
  // 以为服务端拒了这份内容、反复原样重试；实际是网太慢，该提示的是等一等再试。
  if (e instanceof Error && e.name === "TimeoutError") return "保存超时（网络较慢），请稍后重试"
  return "保存失败，请重试"
}

// 步结果编辑回写：把编辑后的结果整份覆盖该步已完成的 result（outline/content/present）。
/** 保存超时：60s。客户网络实测 21-75KB/s，一份大提纲要传十几秒，所以给得宽；
 *  但必须有——请求永不返回时调用方的"保存中"状态会一直钉住，提纲页那边等于把唯一的
 *  落盘通道锁死（自动保存跳过、手动按钮 disabled），之后每一笔编辑都在静默丢失。 */
const PATCH_TIMEOUT_MS = 60_000

export async function patchStep(
  id: string,
  step: "outline" | "content" | "present",
  result: unknown,
): Promise<void> {
  await api.request<{ ok: boolean }>(`/api/projects/${id}/steps/${step}`, {
    method: "PATCH",
    body: JSON.stringify({ result }),
    signal: AbortSignal.timeout(PATCH_TIMEOUT_MS),
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
// kind 为服务端 ARTIFACT_NAME 允许表里的键，2026-08-09 起分册导出会带 docx_tech/pdf_biz 等后缀键
// （见 lib/export-scope.ts 的 artifactKeys），故类型放宽为 string，不再锁死三个字面量。
export async function artifactDownload(
  id: string,
  kind: string,
): Promise<{ url: string; filename: string }> {
  return api.request<{ url: string; filename: string }>(`/api/projects/${id}/artifacts/${kind}`)
}

// 导出预告（2026-08-09 export-scope Task 3 GET /export-preview）：告诉前端本次全套导出会附加的资质附录。
// 挂载导出弹窗时取，失败不影响导出——调用方按静默失败处理（预告区只少一行）。
// 终审 C1：volumes（各册最近一次成功导出时刻，null=从未导出）+ content_changed_at（内容最近一次
// 变更时刻），供下载区判断某册是否已过期（改稿后没重新导出过该册）——字段名与 App API 响应逐字一致。
export type ExportPreview = {
  credentials: { title: string; imageCount: number }[]
  // 2026-08-09 附录系统章节 Task 5：资料库全部资质图片附件的 fileId 平铺，供「资格证明文件」
  // 附录章过期比对用（见 lib/credentials-appendix.ts 的 appendixStale）。
  credential_file_ids: string[]
  volumes: { full: string | null; tech: string | null; biz: string | null }
  content_changed_at: string | null
}
export async function exportPreview(id: string): Promise<ExportPreview> {
  return api.request<ExportPreview>(`/api/projects/${id}/export-preview`)
}

// 附录刷新（2026-08-09 附录系统章节 Task 5，消费 Task 4 的端点）：资料库资质条目改过后，
// 免费重建「资格证明文件」章 HTML（不重新生成整份正文）。无资质条目 409 no_credentials；
// content 步未完成 409 content_not_done；他人项目 404——均以 ApiError 抛出，调用方按码静默处理。
export async function refreshCredentialsAppendix(id: string): Promise<{ html: string }> {
  const result = await api.request<{ html: string }>(`/api/projects/${id}/refresh-credentials-appendix`, {
    method: "POST",
  })
  invalidateProjectCache(id)
  return result
}

/** 述标导出：按当前存库 deck 免费重渲 .pptx 再取预签名 URL。
 *  不用 artifactDownload 直下已存对象——那样编辑器里的修改进不了产物（生产缺陷 2026-07-30）。
 *  「流水线正文」与「用户自己上传标书」两条入口共用本接口，述标结果因此一致。 */
export async function presentRerender(id: string): Promise<{ url: string; filename: string }> {
  return api.request<{ url: string; filename: string }>(`/api/projects/${id}/present/pptx`, { method: "POST" })
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

/** 确认/改判标书分类（spec334）。传 null 清除（回落系统判定值）；传空数组=明确不用分类。 */
export async function setProjectCategory(
  projectId: string,
  category: BidCategoryValue[] | null,
): Promise<void> {
  await api.request(`/api/projects/${projectId}/category`, {
    method: "PATCH",
    body: JSON.stringify(category),
  })
  invalidateProjectCache(projectId)
}
