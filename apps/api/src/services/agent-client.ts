import { getEnv } from "../config/env"
import { getModelConfig, type ModelConfig } from "./model-config"

// 封装 Agent Service 的 run 契约（spec104）。App 对 agent 内部无知，只发 {agent_type, thread_id, input}。
// base_url 走惰性 getEnv（AGENT_BASE_URL），import 无副作用。

// chain 条目 snake（spec319.1）：自建端点带 base_url/api_key；注册表条目二者皆无——agent
// model_override_to_settings 按此形状清洗写入 Settings.model_chain。
// context_window（review 主清单#13）：每跳自己配置的上下文窗口，随该跳一起下发——链上每个
// 模型的窗口可能不同（主 128K + 降级 32K 这类混合链），不能只靠顶层 params 那一个全局值。
export type AgentChainEntry = {
  provider: string
  model: string
  base_url?: string
  api_key?: string
  thinking?: boolean
  context_window?: number
}
export type AgentModelSelection = {
  provider?: string
  model?: string | null
  fallbacks?: string
  // agent 侧认 snake（spec319）；context_window 是主模型（chain[0]）的窗口——agent gateway.py
  // 目前只从这份顶层 params 读窗口（_params_override），chain[] 各跳自带的 context_window
  // 是为降级链准备的信息，暂由 agent 侧后续消费。
  params?: { temperature: number; max_tokens: number; top_p: number; context_window?: number }
  chain?: AgentChainEntry[] // 结构化链（spec319.1）：携带每跳的自建端点，agent 端优先于 fallbacks 字符串
}

/** 从模型注册表派生 run override（纯函数，本机可测）：chain[0]=主，chain[1:]=降级串；
 *  chain 为空或主模型引用失效 → undefined（agent 用 env 默认）。
 *  注意：不检查 test.status——测通门槛只在 saveModelConfig 时把关，run 时永远用已配置的跑（降级铁律）。
 *  spec319.1：额外派生结构化 chain（自建条目带 base_url/api_key）；旧 fallbacks 字符串保留但自建条目跳过
 *  （agent 端 chain 优先，fallbacks 仅遗留兜底，字符串形状装不下 base_url/api_key）。
 *  contextWindow 缺省（未配置）时两处都不下发该键——agent 侧按"键不存在"回落全局兜底窗口，
 *  与"可空=用全局"的语义一致，不发一个 undefined/0 去踩 agent 侧的合法性判断。 */
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
    ...(m.params.contextWindow ? { context_window: m.params.contextWindow } : {}),
  }))
  return {
    provider: primary.provider,
    model: primary.model,
    fallbacks,
    params: {
      temperature: primary.params.temperature,
      max_tokens: primary.params.maxTokens,
      top_p: primary.params.topP,
      ...(primary.params.contextWindow ? { context_window: primary.params.contextWindow } : {}),
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
    // stream: true 不可省：多字节汉字被分片切断时，逐片独立解码会产生 U+FFFD 静默乱码。
    // 这是比前端更早的一跳——这里坏了，前端怎么修都白搭。
    yield dec.decode(chunk.value, { stream: true }) // 透传 SSE 分片给前端
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
  chapterTitle?: string
  model?: AgentModelSelection
  userId?: string
  fetchImpl?: typeof fetch // 测试注入用；生产不传
}): Promise<{ chapter_id: string; html: string }> {
  const body: Record<string, unknown> = { chapter_id: opts.chapterId, instruction: opts.instruction }
  if (opts.baseHtml !== undefined) body.base_html = opts.baseHtml
  if (opts.chapterTitle) body.chapter_title = opts.chapterTitle
  if (opts.model) body.model = opts.model // 有配置才下发；无则 agent 用 env 默认（与 createRun 同法）
  if (opts.userId) body.user_id = opts.userId // spec316：改写检索同样按 user_id 隔离
  const doFetch = (opts.fetchImpl ?? fetch)
  const send = () => doFetch(
    `${getEnv().AGENT_BASE_URL}/agents/${opts.agentType}/threads/${opts.threadId}/chapters/rewrite`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      // 120s 是按「改一章已有正文」定的。**从零写一章是另一个量级**——逐章生成那条路给单章
      // 留的是 4~8 分钟（_chapter_heartbeat）。补写复用本通道，按 120s 掐会把慢章掐死，
      // 而客户端中断并不能让 agent 停下：它照样写完并把结果合进图状态，库里却没有，
      // 两边就此分叉，下次再点会走「改写」分支而不是「补写」。
      signal: AbortSignal.timeout(600_000),
    },
  )
  let r: Response
  try {
    r = await send()
  } catch {
    // 连接层失败（请求根本没到 agent，无任何副作用）等 2s 重试一次：2026-08-09 生产实测
    // 容器间瞬断让三次改写连续 502，事后同载荷复现全通——这类抖动不该直接打回用户。
    // 只在 fetch 本身 reject 时重试；agent 已回包的非 2xx 走下面的正常报错，绝不重放。
    await new Promise((res) => setTimeout(res, 2000))
    r = await send()
  }
  if (!r.ok) {
    // 带上 agent 的错误文本：路由据此区分「本章太长改不完整」这类**用户能自己解决**的失败，
    // 只丢状态码的话用户永远只看到「改写失败，请重试」，然后对着一个永远改不完的长章反复重试。
    const detail = await r.json().catch(() => ({}))
    throw new Error(`agent rewriteChapter ${r.status}: ${(detail as { error?: string }).error ?? ""}`)
  }
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

/** POST 到 agent 的同步路由（snake body），非 2xx 抛 AgentHttpError；解析/比对/渲染耗时较长 → 120s。
 *  timeoutMs 可覆盖：带 OCR 的附件解析是分钟量级的后台活（见 parseAttachmentText）。 */
async function postSync<T>(path: string, body: Record<string, unknown>, timeoutMs = 120_000): Promise<T> {
  const r = await fetch(`${getEnv().AGENT_BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
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

/** 资料库文档附件正文解析（spec 2026-08-11）：无状态同步路由，agent 只回纯文本（扫描版 PDF
 *  在 agent 侧走 OCR）。422（不支持的类型/解析失败）经 postSync 抛 AgentHttpError，
 *  调用方按「这个附件没有可索引正文」处理，不影响条目保存。
 *
 *  720s 超时：agent 侧单附件 OCR 时长预算是 10 分钟（routes/parse_text._OCR_BUDGET_S），
 *  这里必须**大于**它，否则识别刚要收尾就被我们自己掐断——改那个常量必须同步复核这里。
 *  调用方是后台 fire-and-forget（services/library-text），没有用户在干等这条请求。 */
export async function parseAttachmentText(payload: { key: string; maxChars: number }): Promise<{
  text: string
  kind: string
  chars: number
  truncated: boolean
  image_pages: number
  ocr_pages: number
  no_text: boolean
}> {
  return postSync("/tools/parse-text", { key: payload.key, max_chars: payload.maxChars }, 720_000)
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

/** 述标 deck 重渲（编辑后导出/渲染器升级后重出）：无状态、免计费——present 步已收过费，
 *  且这是确定性渲染（无 LLM，只花本机 CPU）。落回 present 节点用的同一个 key，重渲即覆盖。 */
export async function renderDeck(payload: {
  threadId: string
  deck: unknown
  template?: string | null
  enterpriseTemplateKey?: string | null
}): Promise<{ key: string }> {
  const body: Record<string, unknown> = { thread_id: payload.threadId, deck: payload.deck }
  if (payload.template) body.template = payload.template
  if (payload.enterpriseTemplateKey) body.enterprise_template_key = payload.enterpriseTemplateKey
  return postSync("/render/deck", body)
}

/** 标书分析报告渲染（读标结论全量落 docx）：无状态、免计费——读标步已收过费。 */
export async function renderReadReport(payload: Record<string, unknown>): Promise<{ key: string }> {
  return postSync("/render/read-report", payload)
}

/** 定制审核表生成（spec333）：读标结论 + 后台模型 → 一次 LLM 调用产分组核对项。
 *  model 有配置才下发（同 createRun/rewrite）；非 2xx（含 502 模型失败）抛 AgentHttpError，
 *  App 侧 ensureChecklistTemplate best-effort 兜底回落默认 36。groups 已是干净 id（agent 归一化）。 */
export async function generateChecklist(
  readResult: Record<string, unknown>,
  model?: AgentModelSelection,
  bidCategory?: string[],
): Promise<{ groups: Array<{ id: string; title: string; items: string[] }> }> {
  const body: Record<string, unknown> = { read_result: readResult }
  if (model) body.model = model
  // spec334：这条是同步接口、没有 run_input，分类只能走 body。**必须显式下发有效值**——
  // agent 侧虽然也会回落 read_result.bid_category，但那是判定值，用户改判后的确认值不在里面。
  // 空数组也要发：那是「用户明确不用分类」，不发等于让 agent 回落判定值，用户关不掉。
  if (bidCategory) body.bid_category = bidCategory
  return postSync("/generate/checklist", body)
}

/** 查 run 终态。对账/自愈的判死依据——错误语义必须分明：
 *  404 = run 确实不存在（返回 status:null，调用方可判死退款）;
 *  其余非 2xx / 超时 = agent 不可达（抛错，调用方按「活」处理绝不误杀）——
 *  代理返回的 JSON 错误页若被当正常体解析成 {status:undefined}，会把活 run 判死退款。
 *  10s 超时：单个黑洞连接不能拖死整轮对账扫描。 */
export async function getRun(
  runId: string,
): Promise<{ status: string | null; result?: unknown; error?: string | null; errorType?: string | null }> {
  const r = await fetch(`${getEnv().AGENT_BASE_URL}/runs/${runId}`, { signal: AbortSignal.timeout(10_000) })
  if (r.status === 404) return { status: null }
  if (!r.ok) throw new Error(`agent getRun ${r.status}`)
  const raw = (await r.json()) as { status: string; result?: unknown; error?: string; error_type?: string }
  return { status: raw.status, result: raw.result, error: raw.error ?? null, errorType: raw.error_type ?? null }
}

/** agent 的失败原因里，哪些适合原样给用户看。
 *
 *  只放行 RuntimeError：节点里 `raise RuntimeError("上传的标书未能解析出任何正文…")` 这类是我们
 *  自己为用户写的话，可行动、无内部细节。其它异常（ValueError/TypeError…）是代码 bug，
 *  原文（如 `invalid literal for int() with base 10: 'wer'`）对用户毫无意义，还可能带出内部结构。 */
/** 除 RuntimeError 外也放行的异常类：它们同样自带面向用户的中文文案。
 *  ModelIdleTimeout = 模型长时间无响应（2026-08-08：用户跑了 57 分钟失败，界面上没有任何原因）。
 *  ModelNotConfigured = 模型唯一来自运营后台配置、未配置时我们自己抛出的带根因错误（终审
 *  wave2：此前不在白名单里，被过滤回通用「生成失败，请重试」，用户对着永远不会成功的配置缺失反复重试）。 */
const USER_FACING_ERROR_TYPES = new Set(["RuntimeError", "ModelIdleTimeout", "ModelNotConfigured"])

export function userFacingRunError(e: { error?: string | null; errorType?: string | null }): string | null {
  const msg = (e.error ?? "").trim()
  if (!msg || !USER_FACING_ERROR_TYPES.has(e.errorType ?? "")) return null
  if (msg.includes("Traceback")) return null // 兜底：别把栈喂给用户
  return msg.slice(0, 200)
}

export type AgentClient = {
  createRun: typeof createRun
  relayStream: typeof relayStream
  getRun: typeof getRun
}

/** 单章改写/补写失败的可展示原因。
 *
 *  **白名单，不是黑名单**：agent 侧的兜底是 `except Exception: {"error": str(e)}`，
 *  裸传等于把上游响应体、base_url、模型名这些内部细节甩到浏览器里；
 *  网络层失败还会变成「The operation timed out.」「fetch failed」这种对用户毫无意义的英文。
 *  只放行我们自己为用户写的那几句话，其余一律回 undefined，由前端给通用文案。
 *  2026-08-08：从未生成过的章被守卫拒掉，用户只看到「请稍后重试」，对着做不到的事反复重试——
 *  要放行的正是「章节不存在」这类**可行动**的原因。 */
const REWRITE_USER_FACING = [
  /^章节不存在[:：]/,          // 章 id 不在提纲里（前端据此提示重新生成提纲）
  /^上传的标书未能解析出/,      // 节点里为用户写的中文说明
  /^招标文件的解析结果过大/,
  /^rewrite_truncated[:：]/,   // 路由另有 422 分支，这里兜底
]

export function rewriteFailureDetail(e: unknown): string | undefined {
  const raw = e instanceof Error ? e.message : ""
  if (!raw) return undefined
  // 客户端封装的前缀（`agent rewriteChapter 404: …`）去掉，只留服务端那句话
  const msg = raw.replace(/^agent rewriteChapter \d+:\s*/, "").trim()
  if (!msg || !REWRITE_USER_FACING.some((re) => re.test(msg))) return undefined
  return msg.slice(0, 200)
}
