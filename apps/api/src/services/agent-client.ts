import { getEnv } from "../config/env"
import { getConfig } from "./config"

// 封装 Agent Service 的 run 契约（spec104）。App 对 agent 内部无知，只发 {agent_type, thread_id, input}。
// base_url 走惰性 getEnv（AGENT_BASE_URL），import 无副作用。

export type AgentModelSelection = { provider?: string; model?: string | null; fallbacks?: string }

/** 读运营后台配置的 agent 模型选择（spec311）；缺省 undefined → 用 agent env 默认。 */
export async function getAgentModel(): Promise<AgentModelSelection | undefined> {
  return getConfig<AgentModelSelection>("agent_model")
}

export async function createRun(opts: { agentType: string; threadId: string; input: unknown; model?: AgentModelSelection }) {
  const body: Record<string, unknown> = { thread_id: opts.threadId, input: opts.input }
  if (opts.model) body.model = opts.model // 有配置才下发；无则 agent 用 env 默认
  const r = await fetch(`${getEnv().AGENT_BASE_URL}/agents/${opts.agentType}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`agent createRun ${r.status}`)
  return (await r.json()) as { run_id: string }
}

export async function* relayStream(runId: string): AsyncGenerator<string> {
  const r = await fetch(`${getEnv().AGENT_BASE_URL}/runs/${runId}/stream`)
  const reader = r.body!.getReader()
  const dec = new TextDecoder()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    yield dec.decode(value) // 透传 SSE 分片给前端
  }
}

/** 单章改写（spec315a）：agent 同步路由，LLM 改写耗时较长 → 超时放宽 120s。
 *  chapter_id 是 agent 章节 id（字符串，非 uuid）；agent 侧 merge reducer 保证只更新该章。
 *  baseHtml：DB 里该章现值（编辑过=编辑后），作改写底稿——agent state 里的可能是旧稿。 */
export async function rewriteChapter(opts: {
  agentType: string
  threadId: string
  chapterId: string
  instruction: string
  baseHtml?: string
  model?: AgentModelSelection
}): Promise<{ chapter_id: string; html: string }> {
  const body: Record<string, unknown> = { chapter_id: opts.chapterId, instruction: opts.instruction }
  if (opts.baseHtml !== undefined) body.base_html = opts.baseHtml
  if (opts.model) body.model = opts.model // 有配置才下发；无则 agent 用 env 默认（与 createRun 同法）
  const r = await fetch(
    `${getEnv().AGENT_BASE_URL}/agents/${opts.agentType}/threads/${opts.threadId}/chapters/rewrite`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    },
  )
  if (!r.ok) throw new Error(`agent rewriteChapter ${r.status}`)
  return (await r.json()) as { chapter_id: string; html: string }
}

/** agent 同步路由的非 2xx 错误：带状态码与响应体——查重 422（某文件解析失败 {error, file}）
 *  是业务态，App 层需识别并透传给前端；其余状态一律 502。 */
export class AgentHttpError extends Error {
  constructor(
    public status: number,
    public body?: unknown,
  ) {
    super(`agent http ${status}`)
  }
}

/** POST 到 agent 的同步路由（snake body），非 2xx 抛 AgentHttpError；解析/比对/渲染耗时较长 → 120s。 */
async function postSync<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const r = await fetch(`${getEnv().AGENT_BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  if (!r.ok) throw new AgentHttpError(r.status, await r.json().catch(() => undefined))
  return (await r.json()) as T
}

/** 标书查重（spec315b）：同步纯算法路由（不进 LangGraph thread）。
 *  files 2-3 份 {key, label}（label=上传原始文件名，pairs 里 a/b 以此可读展示）。 */
export async function dedupe(payload: {
  files: Array<{ key: string; label: string }>
  tenderKey?: string
  dims: string[]
  strategy: string
}): Promise<{ pairs: unknown[]; overall: unknown; dims_run: string[] }> {
  const body: Record<string, unknown> = { files: payload.files, dims: payload.dims, strategy: payload.strategy }
  if (payload.tenderKey !== undefined) body.tender_key = payload.tenderKey // 基线扣除用的招标文件
  return postSync("/dedupe", body)
}

/** 审核表渲染（spec315b）：无状态——App 把 groups+状态灌给 agent，agent 出 docx 落 MinIO 返 {key}。
 *  groups 须已是 snake_case（App 层 toSnake 后透传）。 */
export async function renderChecklist(payload: {
  title: string
  projectName?: string
  groups: unknown[]
}): Promise<{ key: string }> {
  const body: Record<string, unknown> = { title: payload.title, groups: payload.groups }
  if (payload.projectName !== undefined) body.project_name = payload.projectName
  return postSync("/render/checklist", body)
}

export async function getRun(runId: string) {
  const r = await fetch(`${getEnv().AGENT_BASE_URL}/runs/${runId}`)
  return (await r.json()) as { status: string; result?: unknown }
}

export type AgentClient = {
  createRun: typeof createRun
  relayStream: typeof relayStream
  getRun: typeof getRun
}
