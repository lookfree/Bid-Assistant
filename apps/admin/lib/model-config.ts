// 模型管理（spec319 Task C）：与 App API `/admin-api/models` 契约对齐的类型 + 纯逻辑。
// 纯逻辑（无 React/DOM 依赖）单独放这里，便于 bun test 直接测；页面/组件只做渲染与状态编排。

export type Provider = "deepseek" | "qwen" | "glm"

export type ModelParams = { temperature: number; maxTokens: number; topP: number }

export type ModelTestStatus = "passed" | "failed" | "untested"

export type ModelTest = { status: ModelTestStatus; at?: string; latencyMs?: number; error?: string | null }

export type ModelEntry = {
  id: string
  provider: Provider
  model: string
  params: ModelParams
  enabled: boolean
  test: ModelTest
}

export type ModelConfig = { models: ModelEntry[]; chain: string[] }

// 新建模型卡片的默认参数（brief 指定）。
export const DEFAULT_MODEL_PARAMS: ModelParams = { temperature: 0.7, maxTokens: 8192, topP: 1.0 }

export const PROVIDER_LABELS: Record<Provider, string> = {
  deepseek: "DeepSeek",
  qwen: "通义千问",
  glm: "智谱 GLM",
}

export const PROVIDER_OPTIONS: { value: Provider; label: string }[] = [
  { value: "deepseek", label: PROVIDER_LABELS.deepseek },
  { value: "qwen", label: PROVIDER_LABELS.qwen },
  { value: "glm", label: PROVIDER_LABELS.glm },
]

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
export function persistedChainFor(savedChain: string[], removeId?: string): string[] {
  return removeId ? savedChain.filter((id) => id !== removeId) : savedChain.slice()
}

// 运行编排段顶部的「当前生效」文案：主模型 + 降级顺序。chain 为空时给出引导文案。
export function chainSummary(cfg: ModelConfig): string {
  const byId = (id: string) => cfg.models.find((m) => m.id === id)
  const primary = cfg.chain[0] ? byId(cfg.chain[0]) : undefined
  if (!primary) return "尚未配置主模型，请先在下方模型库启用并测试一个模型"
  const name = (m: ModelEntry) => `${PROVIDER_LABELS[m.provider]} ${m.model}`
  const fallbacks = cfg.chain.slice(1).map(byId).filter((m): m is ModelEntry => !!m)
  const head = `当前生效：${name(primary)}`
  if (fallbacks.length === 0) return head
  return `${head}，失败依次降级 ${fallbacks.map(name).join(" → ")}`
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
