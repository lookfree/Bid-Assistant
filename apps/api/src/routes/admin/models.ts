import { Hono } from "hono"
import { z } from "zod"
import { requirePermission } from "../../middleware/admin-auth"
import { writeAudit } from "../../services/audit"
import {
  ModelConfigSchema,
  getModelConfig,
  saveModelConfig,
  maskModelConfig,
  mergeModelSecrets,
  UnknownProviderError,
  InvalidParamsError,
  ChainRequiresTestedError,
} from "../../services/model-config"
import { testModel, listModels } from "../../services/agent-client"
import type { AdminUser } from "../../db/schema"

// 模型库 + 编排链管理（spec319 Task B，spec319.1 加自建端点）：读=沿用 /plans/configs 的只读约定
// （不加 requirePermission）；写/测试连通性/list-models 中转=config.write。
export const modelsRouter = new Hono<{ Variables: { admin: AdminUser } }>()

// GET 永不回显明文 apiKey——自建条目只出 apiKeyHint（打码）。
modelsRouter.get("/", async (c) => c.json(maskModelConfig(await getModelConfig())))

modelsRouter.put("/", requirePermission("config.write"), async (c) => {
  // 形状校验（zod，同 plans.ts 的 ConfigBody 套路）；语义校验（白名单/params 范围/chain 测通）在 saveModelConfig 里做。
  const parsed = ModelConfigSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
  const stored = await getModelConfig()
  // 自建条目未带新 apiKey（前端展示的是打码 hint，不是明文）⇒ 按 id 从库里旧值合并回填，避免覆盖成空。
  const merged = mergeModelSecrets(parsed.data, stored)
  try {
    await saveModelConfig(merged)
  } catch (e) {
    if (e instanceof UnknownProviderError) return c.json({ error: "unknown_provider" }, 400)
    if (e instanceof InvalidParamsError) return c.json({ error: "invalid_params" }, 400)
    if (e instanceof ChainRequiresTestedError) return c.json({ error: "chain_requires_tested_models" }, 400)
    throw e
  }
  // 审计 before/after 一律打码——明文 apiKey 不进 adminAuditLogs。
  await writeAudit({
    operator: c.var.admin.username,
    action: "config.write",
    target: "config:agent_model",
    before: maskModelConfig(stored),
    after: maskModelConfig(merged),
  })
  return c.json({ ok: true })
})

// 与 agent testModel(opts) 的 snake 入参直接对齐——纯中转，不做 camel/snake 转换。
// 已保存的自建条目 apiKey 打码不回显（GET 只出 hint）；探针/拉取时前端不带 key、只带 id ⇒
// 按 id 从库里取回明文 key（同 PUT 的 mergeModelSecrets 思路），否则会用空 key 探活→假失败→模型被误踢出链。
async function resolveStoredKey(id: string | undefined): Promise<string | undefined> {
  if (!id) return undefined
  return (await getModelConfig()).models.find((m) => m.id === id)?.apiKey
}

const TestBody = z.object({
  provider: z.string().min(1),
  model: z.string().min(1).optional(),
  params: z
    .object({
      temperature: z.number().optional(),
      max_tokens: z.number().optional(),
      top_p: z.number().optional(),
    })
    .optional(),
  base_url: z.string().optional(),
  api_key: z.string().optional(),
  id: z.string().optional(), // 已保存条目：无明文 key 时据此回填库里 key（自建必带、内置服务商可选覆盖）
})
modelsRouter.post("/test", requirePermission("config.write"), async (c) => {
  const parsed = TestBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
  const { id, ...body } = parsed.data
  // 按 api_key 缺省与否判定是否回填库里 key，不再要求 base_url 同时存在——内置服务商现在也能只覆盖
  // apiKey（不覆盖 base_url），若仍要求 base_url 才回填，重测时这个覆盖 key 会被静默忽略、退回 env 默认。
  if (!body.api_key) body.api_key = await resolveStoredKey(id)
  return c.json(await testModel(body))
})

// 自建端点探连通 + 拉可用模型列表——纯中转 agent /models/list-models，不落库。
// apiKey 可缺省：已保存条目走 id 回填库里 key（前端拿不到明文）。
// provider（内置 deepseek/qwen/glm）：agent 侧按注册表解析 base_url + 服务端 env 取 key，无需前端带 baseUrl/apiKey。
// 二者二选一——带 provider 且不带 baseUrl 时走内置路径；否则沿用自建端点路径。
const ListModelsBody = z
  .object({
    provider: z.string().min(1).optional(),
    baseUrl: z.string().url().optional(),
    apiKey: z.string().optional(),
    id: z.string().optional(),
  })
  .refine((v) => !!v.provider || !!v.baseUrl, { message: "provider or baseUrl required" })
modelsRouter.post("/list-models", requirePermission("config.write"), async (c) => {
  const parsed = ListModelsBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
  const { provider, baseUrl, id } = parsed.data
  // 内置服务商拉取：优先用表单/库里存的 key（与「测试连通」一致），agent 侧再回退 env——
  // 后台已配 key 的内置模型也能拉取，不必强依赖服务端 env（呼应「key 从后台配」）。
  if (provider && !baseUrl) {
    const key = parsed.data.apiKey || (id ? await resolveStoredKey(id) : undefined)
    return c.json(await listModels({ provider, apiKey: key }))
  }
  const apiKey = parsed.data.apiKey || (await resolveStoredKey(id))
  if (!apiKey) return c.json({ ok: false, error: "缺少 API Key" })
  return c.json(await listModels({ baseUrl, apiKey }))
})
