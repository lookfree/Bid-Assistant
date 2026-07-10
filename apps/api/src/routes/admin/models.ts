import { Hono } from "hono"
import { z } from "zod"
import { requirePermission } from "../../middleware/admin-auth"
import { writeAudit } from "../../services/audit"
import {
  ModelConfigSchema,
  getModelConfig,
  saveModelConfig,
  UnknownProviderError,
  InvalidParamsError,
  ChainRequiresTestedError,
} from "../../services/model-config"
import { testModel } from "../../services/agent-client"
import type { AdminUser } from "../../db/schema"

// 模型库 + 编排链管理（spec319 Task B）：读=沿用 /plans/configs 的只读约定（不加 requirePermission）；
// 写/测试连通性=config.write。
export const modelsRouter = new Hono<{ Variables: { admin: AdminUser } }>()

modelsRouter.get("/", async (c) => c.json(await getModelConfig()))

modelsRouter.put("/", requirePermission("config.write"), async (c) => {
  // 形状校验（zod，同 plans.ts 的 ConfigBody 套路）；语义校验（白名单/params 范围/chain 测通）在 saveModelConfig 里做。
  const parsed = ModelConfigSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
  const before = await getModelConfig()
  try {
    await saveModelConfig(parsed.data)
  } catch (e) {
    if (e instanceof UnknownProviderError) return c.json({ error: "unknown_provider" }, 400)
    if (e instanceof InvalidParamsError) return c.json({ error: "invalid_params" }, 400)
    if (e instanceof ChainRequiresTestedError) return c.json({ error: "chain_requires_tested_models" }, 400)
    throw e
  }
  await writeAudit({ operator: c.var.admin.username, action: "config.write", target: "config:agent_model", before, after: parsed.data })
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
})
modelsRouter.post("/test", requirePermission("config.write"), async (c) => {
  const parsed = TestBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
  return c.json(await testModel(parsed.data))
})
