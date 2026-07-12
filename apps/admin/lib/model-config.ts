// 模型管理（spec319 Task C）：与 App API `/admin-api/models` 契约对齐的类型 + 纯逻辑。
// 纯逻辑（无 React/DOM 依赖）单独放这里，便于 bun test 直接测；页面/组件只做渲染与状态编排。

// provider 放宽为自由字符串（spec319.1）：自建/任意 OpenAI 兼容端点条目的 provider 是自由标签
// （固定用 "custom"），不再限于注册表 3 家；PROVIDER_LABELS 对未知 key 用 providerLabel() 兜底。
export type Provider = string

export type ModelParams = { temperature: number; maxTokens: number; topP: number }

export type ModelTestStatus = "passed" | "failed" | "untested"

export type ModelTest = { status: ModelTestStatus; at?: string; latencyMs?: number; error?: string | null }

export type ModelEntry = {
  id: string
  provider: Provider
  model: string
  params: ModelParams
  enabled: boolean
  // 思考模式（可选，默认关）：关=更快更省且可流式强制提交；开=该模型走思考模式（走非流式提交）。
  thinking?: boolean
  test: ModelTest
  // 自建端点专属（spec319.1）：baseUrl 非空 ⇒ 自建条目。apiKey 仅当用户新填时携带（save 用）；
  // apiKeyHint 是 GET 回来的打码提示（如 sk-****yA），从不是明文，仅用于展示 placeholder。
  baseUrl?: string
  apiKey?: string
  apiKeyHint?: string
}

export type ModelConfig = { models: ModelEntry[]; chain: string[] }

// 新建模型卡片的默认参数（brief 指定）。
export const DEFAULT_MODEL_PARAMS: ModelParams = { temperature: 0.7, maxTokens: 8192, topP: 1.0 }

// 各服务商 base_url 注册表默认值（与 agent providers.py 的 PROVIDERS 对齐）：内置服务商的
// baseUrl 输入框用它做 placeholder（留空 = 用这个默认地址），非强制值。
export const PROVIDER_DEFAULT_BASE_URL: Record<string, string> = {
  deepseek: "https://api.deepseek.com/v1",
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  glm: "https://open.bigmodel.cn/api/paas/v4",
}

export function providerDefaultBaseUrl(provider: string): string {
  return PROVIDER_DEFAULT_BASE_URL[provider] ?? ""
}

// 各服务商 max_tokens 默认值（brief 指定）：新建模型 / 切换服务商时用它重置 params.maxTokens。
const PROVIDER_DEFAULT_MAX_TOKENS: Record<string, number> = {
  deepseek: 8192,
  qwen: 8192,
  glm: 4095,
  custom: 4096,
}

export function providerDefaultMaxTokens(provider: string): number {
  return PROVIDER_DEFAULT_MAX_TOKENS[provider] ?? PROVIDER_DEFAULT_MAX_TOKENS.custom
}

export const PROVIDER_LABELS: Record<string, string> = {
  deepseek: "DeepSeek",
  qwen: "通义千问",
  glm: "智谱 GLM",
  custom: "自建 (OpenAI 兼容)",
}

export const PROVIDER_OPTIONS: { value: Provider; label: string }[] = [
  { value: "deepseek", label: PROVIDER_LABELS.deepseek },
  { value: "qwen", label: PROVIDER_LABELS.qwen },
  { value: "glm", label: PROVIDER_LABELS.glm },
  { value: "custom", label: PROVIDER_LABELS.custom },
]

// PROVIDER_LABELS 的兜底查找：未知 provider（理论上不该出现，防御性兜底）一律显示「自建」。
export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? "自建"
}

// 是否自建模式：只看 provider 是否为「custom」（自由标签）。内置服务商（deepseek/qwen/glm）现在
// 也可以带 baseUrl/apiKey（可选覆盖，见 PROVIDER_DEFAULT_BASE_URL），baseUrl 存在与否不再是判据，
// 否则内置服务商一旦填了覆盖地址就会被误判成自建、丢了 provider 选择器与拉取可用模型入口。
export function isCustomEntry(m: Pick<ModelEntry, "provider" | "baseUrl">): boolean {
  return m.provider === "custom"
}

// 展示名：自建条目（带 baseUrl）用 `model @ host`；否则回退注册表 `label model`
// （host 解析失败时也回退这个格式）。chainSummary / model-card 共用。
export function modelDisplayName(m: ModelEntry): string {
  if (m.baseUrl) {
    try {
      return `${m.model} @ ${new URL(m.baseUrl).host}`
    } catch {
      // 格式异常的 baseUrl：落回下面的通用格式。
    }
  }
  return `${providerLabel(m.provider)} ${m.model}`
}

// PUT /admin-api/models 是 camelCase（maxTokens/topP），POST /models/test 是 snake_case
// （max_tokens/top_p，agent 侧薄中转）。两者不同，混用会让参数在服务端悄悄变成 {}。
export function camelToSnakeParams(params: ModelParams): {
  temperature: number
  max_tokens: number
  top_p: number
} {
  return { temperature: params.temperature, max_tokens: params.maxTokens, top_p: params.topP }
}

// 启用开关的门槛：必须测试通过。未测试/测试失败都不能开启用。
export function canEnable(model: ModelEntry): boolean {
  return model.test.status === "passed"
}

// 能否加入运行编排（主模型/降级链）：必须已启用 + 测试通过（与后端 PUT 校验一致，前端先拦）。
export function canAddToChain(model: ModelEntry): boolean {
  return model.enabled && model.test.status === "passed"
}

// 链内上下调序：越界方向不做任何变化（返回内容相等的新数组）。
export function moveInChain(chain: string[], id: string, dir: "up" | "down"): string[] {
  const i = chain.indexOf(id)
  if (i < 0) return chain.slice()
  const j = dir === "up" ? i - 1 : i + 1
  if (j < 0 || j >= chain.length) return chain.slice()
  const next = chain.slice()
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}

// 改动 provider/model/params 后旧测试结果作废，重置为未测试（不保留 at/latencyMs/error）。
export function resetTestOnEdit(model: ModelEntry): ModelEntry {
  return { ...model, test: { status: "untested" } }
}

// 模型是否已在运行编排链中（用于停用前拦截、卡片「已在编排中」展示）。
export function isInChain(chain: string[], id: string): boolean {
  return chain.includes(id)
}

// 即时动作（启用/停用/删除/存参数）持久化时应使用的 chain：一律取「已保存链」，
// 绝不裹挟当前尚未点「保存运行配置」确认的链编辑；removeId 用于删除，同步把该 id 从
// 已保存链剔除以免留下悬空引用。返回新数组（不改入参）。
// 即时动作（启用/停用/删除/存参数）提交时的链 payload：从已保存链里只保留仍然合法（存在+启用+测通）的成员。
// 既不裹挟用户尚未点「保存运行配置」的链编辑，又自愈迁移遗留的未测成员——否则服务端 chain 门槛会
// 用一条无关的启用/删除操作触发 400，把整页卡住。正常（全测通）链下这是无操作。
export function persistedChainFor(savedChain: string[], models: ModelEntry[], removeId?: string): string[] {
  return savedChain.filter((id) => id !== removeId && models.some((m) => m.id === id && canAddToChain(m)))
}

// 运行编排段顶部的「当前生效」文案：主模型 + 降级顺序。chain 为空时给出引导文案。
export function chainSummary(cfg: ModelConfig): string {
  const byId = (id: string) => cfg.models.find((m) => m.id === id)
  const primary = cfg.chain[0] ? byId(cfg.chain[0]) : undefined
  if (!primary) return "尚未配置主模型，请先在下方模型库启用并测试一个模型"
  const fallbacks = cfg.chain.slice(1).map(byId).filter((m): m is ModelEntry => !!m)
  const head = `当前生效：${modelDisplayName(primary)}`
  if (fallbacks.length === 0) return head
  return `${head}，失败依次降级 ${fallbacks.map(modelDisplayName).join(" → ")}`
}

// PUT 400 的 error code → 可读提示；未知 code 给通用失败文案。
export function saveErrorMessage(error?: string): string {
  switch (error) {
    case "chain_requires_tested_models":
      return "降级链里有未测试通过的模型，请先测试"
    case "invalid_params":
      return "参数超出范围"
    case "unknown_provider":
      return "未知服务商"
    default:
      return "保存失败，请重试"
  }
}
