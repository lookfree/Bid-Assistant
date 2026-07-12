import { randomUUID } from "node:crypto"
import { z } from "zod"
import { getConfig, setConfig } from "./config"

// 模型注册表 + 运行编排链（spec319 Task B）：billing_configs key "agent_model" 的新 value 形状。
// 取代旧的单条 {provider,model,fallbacks}；旧结构在读时原地迁移（不回写），写时强校验。

export type ModelParams = { temperature: number; maxTokens: number; topP: number }
export type ModelTest = { status: "passed" | "failed" | "untested"; at?: string; latencyMs?: number; error?: string | null }
// baseUrl 非空 ⇒ 自建/任意 OpenAI 兼容端点条目（spec319.1）：provider 为自由标签，apiKey 明文存库。
// apiKeyHint 仅 GET 出参展示（maskModelConfig 产出），从不由写路径消费。
export type ModelEntry = {
  id: string
  provider: string
  model: string
  params: ModelParams
  enabled: boolean
  test: ModelTest
  baseUrl?: string
  apiKey?: string
  apiKeyHint?: string
}
export type ModelConfig = { models: ModelEntry[]; chain: string[] }

export const PROVIDERS = ["deepseek", "qwen", "glm"] as const
export const DEFAULT_PARAMS: ModelParams = { temperature: 0.7, maxTokens: 8192, topP: 1.0 }

// 与 agent providers.py 的 PROVIDERS 对齐（default_model）。
const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
  deepseek: "deepseek-chat",
  qwen: "qwen-plus",
  glm: "glm-4-flash",
}
function providerDefaultModel(provider: string): string {
  return PROVIDER_DEFAULT_MODEL[provider] ?? provider
}

const genId = () => `m_${randomUUID()}`

// —— 校验错误类型（route 层 instanceof 判断，映射不同 error code）——
export class UnknownProviderError extends Error {
  constructor(public provider: string) {
    super(`未知服务商 ${provider}`)
    this.name = "UnknownProviderError"
  }
}
export class InvalidParamsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidParamsError"
  }
}
export class ChainRequiresTestedError extends Error {
  constructor(public id: string) {
    super(`chain 引用的 model ${id} 不存在或未启用+测通`)
    this.name = "ChainRequiresTestedError"
  }
}

// 形状 schema（route 层解析原始 body 用；service 层 validateModelConfig 只做语义校验，
// 假定入参已是这个形状——由 zod 类型系统在编译期保证，运行期形状交给 route 边界把关）。
const ModelParamsSchema = z.object({ temperature: z.number(), maxTokens: z.number(), topP: z.number() })
const ModelTestSchema = z.object({
  status: z.enum(["passed", "failed", "untested"]),
  at: z.string().optional(),
  latencyMs: z.number().optional(),
  error: z.string().nullable().optional(),
})
const ModelEntrySchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  params: ModelParamsSchema,
  enabled: z.boolean(),
  test: ModelTestSchema,
  baseUrl: z.string().url().optional(),
  apiKey: z.string().optional(),
  apiKeyHint: z.string().optional(),
})
export const ModelConfigSchema = z.object({
  models: z.array(ModelEntrySchema),
  chain: z.array(z.string()),
})

// —— 读侧：新/旧结构判别 + 迁移 + 兜底（纯函数，无 I/O，本机可测）——

type LegacyModelSelection = { provider?: string; model?: string | null; fallbacks?: string }

function isLegacyShape(raw: Record<string, unknown>): raw is LegacyModelSelection {
  return !Array.isArray(raw.models) && ("provider" in raw || "fallbacks" in raw)
}

function migrateLegacy(raw: LegacyModelSelection): ModelConfig {
  const provider = raw.provider ?? "deepseek"
  const primary: ModelEntry = {
    id: genId(),
    provider,
    model: raw.model ?? providerDefaultModel(provider),
    params: { ...DEFAULT_PARAMS },
    enabled: true,
    test: { status: "untested" },
  }
  const fallbackEntries: ModelEntry[] = []
  for (const part of (raw.fallbacks ?? "").split(",")) {
    const item = part.trim()
    if (!item.includes(":")) continue
    const [prov, mdl] = item.split(":").map((s) => s.trim())
    if (!prov || !(PROVIDERS as readonly string[]).includes(prov)) continue // provider 在白名单才要
    fallbackEntries.push({
      id: genId(),
      provider: prov,
      model: mdl || providerDefaultModel(prov),
      params: { ...DEFAULT_PARAMS },
      enabled: true,
      test: { status: "untested" },
    })
  }
  const models = [primary, ...fallbackEntries]
  return { models, chain: models.map((m) => m.id) }
}

function normalizeEntry(m: Record<string, unknown>): ModelEntry {
  const params = (m.params ?? {}) as Partial<ModelParams>
  return {
    id: typeof m.id === "string" && m.id ? m.id : genId(),
    provider: String(m.provider),
    model: String(m.model),
    params: { ...DEFAULT_PARAMS, ...params },
    enabled: m.enabled !== false,
    test: (m.test as ModelTest) ?? { status: "untested" },
    ...(typeof m.baseUrl === "string" && m.baseUrl ? { baseUrl: m.baseUrl } : {}),
    ...(typeof m.apiKey === "string" && m.apiKey ? { apiKey: m.apiKey } : {}),
  }
}

/** 读侧统一入口：空/旧/新三种输入形状 → 规整为当前 ModelConfig（纯函数，只在内存转换，不回写）。 */
export function normalizeModelConfig(raw: unknown): ModelConfig {
  if (!raw || typeof raw !== "object") return { models: [], chain: [] }
  const obj = raw as Record<string, unknown>
  if (isLegacyShape(obj)) return migrateLegacy(obj)
  const models = Array.isArray(obj.models) ? obj.models.map((m) => normalizeEntry(m as Record<string, unknown>)) : []
  const chain = Array.isArray(obj.chain) ? (obj.chain as string[]) : []
  return { models, chain }
}

export async function getModelConfig(): Promise<ModelConfig> {
  return normalizeModelConfig(await getConfig<unknown>("agent_model"))
}

// —— 写侧：语义校验（"启用前必须测通" 的服务端强制，防绕过前端）——

function validateParams(id: string, p: ModelParams): void {
  if (typeof p.temperature !== "number" || p.temperature < 0 || p.temperature > 2) {
    throw new InvalidParamsError(`model ${id}: temperature 需在 0-2 之间`)
  }
  if (typeof p.topP !== "number" || p.topP < 0 || p.topP > 1) {
    throw new InvalidParamsError(`model ${id}: topP 需在 0-1 之间`)
  }
  if (!Number.isInteger(p.maxTokens) || p.maxTokens <= 0 || p.maxTokens > 32768) {
    throw new InvalidParamsError(`model ${id}: maxTokens 需为 1-32768 的正整数`)
  }
}

/** 语义校验（假定形状已合法）：内置服务商（provider 在 PROVIDERS 白名单）baseUrl/apiKey 都是可选覆盖——
 *  留空则 agent 网关分别回退注册表默认地址 / 服务端 env key，带了 baseUrl 才校验协议，不强制 apiKey。
 *  非内置（自建/自由标签）条目沿用旧规则：baseUrl + apiKey 均必填。params 数值范围/id 唯一/chain 门槛两支共用。 */
export function validateModelConfig(cfg: ModelConfig): void {
  const ids = new Set<string>()
  for (const m of cfg.models) {
    if ((PROVIDERS as readonly string[]).includes(m.provider)) {
      if (m.baseUrl && !/^https?:\/\//.test(m.baseUrl)) throw new InvalidParamsError(`model ${m.id}: baseUrl 须为 http/https`)
    } else {
      if (!m.baseUrl || !/^https?:\/\//.test(m.baseUrl)) throw new InvalidParamsError(`model ${m.id}: baseUrl 须为 http/https`)
      if (!m.apiKey) throw new InvalidParamsError(`model ${m.id}: 自建端点必须提供 apiKey`)
    }
    if (!m.model) throw new InvalidParamsError(`model ${m.id}: model 不可为空`)
    validateParams(m.id, m.params)
    if (!m.id) throw new InvalidParamsError("model id 不可为空")
    if (ids.has(m.id)) throw new InvalidParamsError(`model id 重复: ${m.id}`)
    ids.add(m.id)
  }
  const byId = new Map(cfg.models.map((m) => [m.id, m]))
  for (const id of cfg.chain) {
    const m = byId.get(id)
    if (!m || !m.enabled || m.test.status !== "passed") throw new ChainRequiresTestedError(id)
  }
}

export async function saveModelConfig(cfg: ModelConfig): Promise<void> {
  validateModelConfig(cfg)
  await setConfig("agent_model", cfg)
}

// —— 密钥策略（spec319.1）：GET 出参打码、PUT 入参合并旧密钥，二者都只在 route 层调用 ——

/** len>5 ⇒ 首3+****+尾2；否则一律 "****"（太短没法留可辨认前后缀）。 */
export function maskApiKey(key: string): string {
  return key.length > 5 ? `${key.slice(0, 3)}****${key.slice(-2)}` : "****"
}

/** GET 用：任何带明文 apiKey 的条目都不出参，改为 apiKeyHint（打码展示）。
 *  按 apiKey 存在与否判定（非 baseUrl）——防御注册表条目意外落了 key 时明文回显。 */
export function maskModelConfig(cfg: ModelConfig): ModelConfig {
  return {
    ...cfg,
    models: cfg.models.map((m) => {
      if (!m.apiKey) return m
      const { apiKey, ...rest } = m
      return { ...rest, apiKeyHint: maskApiKey(apiKey) }
    }),
  }
}

/** PUT 用：任何条目（内置服务商或自建）若未带新 apiKey（空/缺省），按 id 从 stored 取回旧值；带了新值则
 *  用新值覆盖。按 apiKey 存在与否判定，不看 baseUrl——内置服务商现在也可能只覆盖了 apiKey（不覆盖 baseUrl），
 *  若仍按旧的「只有 baseUrl 非空才合并」判据，这种条目的 apiKey 会在每次重新保存时被静默丢失。
 *  合并后仍需 validateModelConfig 把关（新建自建条目无任何旧值可填回 ⇒ 校验时因 apiKey 缺失被拒）。 */
export function mergeModelSecrets(incoming: ModelConfig, stored: ModelConfig): ModelConfig {
  const storedById = new Map(stored.models.map((m) => [m.id, m]))
  return {
    ...incoming,
    models: incoming.models.map((m) => {
      if (m.apiKey) return m
      const prevKey = storedById.get(m.id)?.apiKey
      return prevKey ? { ...m, apiKey: prevKey } : m
    }),
  }
}
