import { getEnv } from "../config/env"
import { getModelConfig, type ModelConfig } from "./model-config"

// 封装 Agent Service 的 run 契约（spec104）。App 对 agent 内部无知，只发 {agent_type, thread_id, input}。
// base_url 走惰性 getEnv（AGENT_BASE_URL），import 无副作用。

// chain 条目 snake（spec319.1）：自建端点带 base_url/api_key；注册表条目二者皆无——agent
// model_override_to_settings 按此形状清洗写入 Settings.model_chain。
export type AgentChainEntry = { provider: string; model: string; base_url?: string; api_key?: string; thinking?: boolean }
export type AgentModelSelection = {
  provider?: string
  model?: string | null
  fallbacks?: string
  params?: { temperature: number; max_tokens: number; top_p: number } // agent 侧认 snake（spec319）
  chain?: AgentChainEntry[] // 结构化链（spec319.1）：携带每跳的自建端点，agent 端优先于 fallbacks 字符串
}

/** 从模型注册表派生 run override（纯函数，本机可测）：chain[0]=主，chain[1:]=降级串；
 *  chain 为空或主模型引用失效 → undefined（agent 用 env 默认）。
 *  注意：不检查 test.status——测通门槛只在 saveModelConfig 时把关，run 时永远用已配置的跑（降级铁律）。
 *  spec319.1：额外派生结构化 chain（自建条目带 base_url/api_key）；旧 fallbacks 字符串保留但自建条目跳过
 *  （agent 端 chain 优先，fallbacks 仅遗留兜底，字符串形状装不下 base_url/api_key）。 */
export function deriveRunOverride(cfg: ModelConfig): AgentModelSelection | undefined {
  if (!cfg.chain.length) return undefined
  const primary = cfg.models.find((m) => m.id === cfg.chain[0])
  if (!primary) return undefined
  const chainEntries = cfg.chain
    .map((id) => cfg.models.find((m) => m.id === id))
    .filter((m): m is NonNullable<typeof m> => !!m)
  const fallbacks = chainEntries
    .slice(1)
    .filter((m) => !m.baseUrl)
    .map((m) => `${m.provider}:${m.model}`)
    .join(",")
  const chain: AgentChainEntry[] = chainEntries.map((m) => ({
    provider: m.provider,
    model: m.model,
    thinking: m.thinking === true, // 每模型思考开关（默认关）；agent 据此决定是否下发关闭思考的 extra_body
    ...(m.baseUrl ? { base_url: m.baseUrl } : {}),
    ...(m.apiKey ? { api_key: m.apiKey } : {}),
  }))
  return {
    provider: primary.provider,
    model: primary.model,
    fallbacks,
    params: {
      temperature: primary.params.temperature,
      max_tokens: primary.params.maxTokens,
      top_p: primary.params.topP,
    },
    chain,
  }
}

/** 读运营后台配置的 agent 模型选择（spec311，spec319 起从模型注册表派生）；缺省 undefined → 用 agent env 默认。 */
export async function getAgentModel(): Promise<AgentModelSelection | undefined> {
  return deriveRunOverride(await getModelConfig())
}

/** 模型连通性测试中转（spec319/spec319.1）：relay 到 agent `/models/test`，不落库不改配置——纯探针。
 *  base_url/api_key 非空 ⇒ 自建端点探活（agent 侧跳过 provider 白名单）；二者皆缺省 ⇒ 原注册表路径不变。
 *  超时放宽 20s（LLM 首 token 慢）；agent 恒回 JSON（含 400 非白名单场景），原样解析、camel 化字段名。 */
export async function testModel(opts: {
  provider: string
  model?: string
  params?: { temperature?: number; max_tokens?: number; top_p?: number }
  base_url?: string
  api_key?: string
}): Promise<{ ok: boolean; latencyMs?: number; tokens?: number; maxOutput?: number; error?: string }> {
  const r = await fetch(`${getEnv().AGENT_BASE_URL}/models/test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts),
    signal: AbortSignal.timeout(20_000),
  })
  const body = (await r.json()) as {
    ok: boolean
    latency_ms?: number
    tokens?: number
    max_output?: number | null
    error?: string
  }
  return {
    ok: body.ok,
    latencyMs: body.latency_ms,
    tokens: body.tokens,
    maxOutput: body.max_output ?? undefined,
    error: body.error,
  }
}

/** 可用模型列举中转（spec319.1 自建端点 + 内置服务商拉取）：relay 到 agent `/models/list-models`，纯查询、不落库。
 *  agent 恒回 JSON（httpx 超时/连接拒绝/解析错都收敛成 {ok:false,error}，永不 500）；超时放宽 15s。
 *  provider 非空 ⇒ 内置服务商路径（agent 从注册表解析 base_url + 服务端 env 取 key）；否则走自建端点
 *  base_url/api_key。两者互斥，由调用方决定传哪一组。 */
export async function listModels(opts: { baseUrl?: string; apiKey?: string; provider?: string }): Promise<{ ok: boolean; models?: string[]; error?: string }> {
  const body: Record<string, unknown> = {}
  if (opts.provider) body.provider = opts.provider
  if (opts.baseUrl) body.base_url = opts.baseUrl
  if (opts.apiKey) body.api_key = opts.apiKey
  const r = await fetch(`${getEnv().AGENT_BASE_URL}/models/list-models`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  return (await r.json()) as { ok: boolean; models?: string[]; error?: string }
}

export async function createRun(opts: {
  agentType: string
  threadId: string
  input: unknown
  model?: AgentModelSelection
  userId?: string
}) {
  const body: Record<string, unknown> = { thread_id: opts.threadId, input: opts.input }
  if (opts.model) body.model = opts.model // 有配置才下发；无则 agent 用 env 默认
  if (opts.userId) body.user_id = opts.userId // spec316：节点按 user_id 隔离 RAG 检索
  const r = await fetch(`${getEnv().AGENT_BASE_URL}/agents/${opts.agentType}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`agent createRun ${r.status}`)
  return (await r.json()) as { run_id: string }
}

// SSE 心跳间隔：LLM 步骤事件间隙可达 60s（read）~数分钟（content 单节点），无数据流动会被
// Bun idleTimeout（默认 10s）/反向代理掐连接 → 步骤被误判失败。心跳是 SSE 注释行，EventSource 自动忽略。
export const RELAY_HEARTBEAT_MS = 8000

export async function* relayStream(runId: string, heartbeatMs = RELAY_HEARTBEAT_MS): AsyncGenerator<string> {
  const r = await fetch(`${getEnv().AGENT_BASE_URL}/runs/${runId}/stream`)
  const reader = r.body!.getReader()
  const dec = new TextDecoder()
  for (;;) {
    const next = reader.read() // 同一个 read promise 跨多次心跳保留，不能丢弃重发
    let chunk: { done: boolean; value?: Uint8Array } | undefined
    while (chunk === undefined) {
      const winner = await Promise.race([
        next.then((v) => ({ v })),
        new Promise<"hb">((res) => setTimeout(() => res("hb"), heartbeatMs)),
      ])
      if (winner === "hb") {
        yield ": hb\n\n" // 心跳注释帧：保活连接
        continue
      }
      chunk = winner.v
    }
    if (chunk.done) break
    yield dec.decode(chunk.value) // 透传 SSE 分片给前端
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
  userId?: string
}): Promise<{ chapter_id: string; html: string }> {
  const body: Record<string, unknown> = { chapter_id: opts.chapterId, instruction: opts.instruction }
  if (opts.baseHtml !== undefined) body.base_html = opts.baseHtml
  if (opts.model) body.model = opts.model // 有配置才下发；无则 agent 用 env 默认（与 createRun 同法）
  if (opts.userId) body.user_id = opts.userId // spec316：改写检索同样按 user_id 隔离
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

/** 资料库条目建库/查重索引（spec316）：best-effort——调用方 try/catch 兜底，绝不阻塞 CRUD 响应。
 *  超时放宽 30s（向量化耗时高于普通接口，但不能拖到 rewrite 级别的 120s）。 */
export async function ragIndex(opts: {
  userId: string
  sourceId: string
  title: string
  text: string
}): Promise<void> {
  const r = await fetch(`${getEnv().AGENT_BASE_URL}/rag/index`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      user_id: opts.userId,
      source_type: "library",
      source_id: opts.sourceId,
      title: opts.title,
      text: opts.text,
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!r.ok) throw new Error(`agent ragIndex ${r.status}`)
}

/** 资料库条目删索引（spec316）：同 ragIndex，best-effort、调用方兜底。 */
export async function ragDelete(opts: { userId: string; sourceType: string; sourceId: string }): Promise<void> {
  const r = await fetch(
    `${getEnv().AGENT_BASE_URL}/rag/index/${encodeURIComponent(opts.sourceType)}/${encodeURIComponent(opts.sourceId)}?user_id=${encodeURIComponent(opts.userId)}`,
    { method: "DELETE", signal: AbortSignal.timeout(30_000) },
  )
  if (!r.ok) throw new Error(`agent ragDelete ${r.status}`)
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

/** 废标体检报告渲染：同审核表范式（无状态、免计费——体检 review 步已收过费）。
 *  format=pdf 为 best-effort（LibreOffice），失败回落 docx，返回的 format 如实反映实际产物。 */
export async function renderRiskReport(payload: Record<string, unknown>): Promise<{ key: string; format: "docx" | "pdf" }> {
  return postSync("/render/risk-report", payload)
}

/** 查 run 终态。对账/自愈的判死依据——错误语义必须分明：
 *  404 = run 确实不存在（返回 status:null，调用方可判死退款）;
 *  其余非 2xx / 超时 = agent 不可达（抛错，调用方按「活」处理绝不误杀）——
 *  代理返回的 JSON 错误页若被当正常体解析成 {status:undefined}，会把活 run 判死退款。
 *  10s 超时：单个黑洞连接不能拖死整轮对账扫描。 */
export async function getRun(runId: string): Promise<{ status: string | null; result?: unknown }> {
  const r = await fetch(`${getEnv().AGENT_BASE_URL}/runs/${runId}`, { signal: AbortSignal.timeout(10_000) })
  if (r.status === 404) return { status: null }
  if (!r.ok) throw new Error(`agent getRun ${r.status}`)
  return (await r.json()) as { status: string; result?: unknown }
}

export type AgentClient = {
  createRun: typeof createRun
  relayStream: typeof relayStream
  getRun: typeof getRun
}
