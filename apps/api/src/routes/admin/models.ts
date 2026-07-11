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
})
modelsRouter.post("/test", requirePermission("config.write"), async (c) => {
  const parsed = TestBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
  return c.json(await testModel(parsed.data))
})

// 自建端点探连通 + 拉可用模型列表——纯中转 agent /models/list-models，不落库。
const ListModelsBody = z.object({ baseUrl: z.string().url(), apiKey: z.string().min(1) })
modelsRouter.post("/list-models", requirePermission("config.write"), async (c) => {
  const parsed = ListModelsBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
  return c.json(await listModels(parsed.data))
})
