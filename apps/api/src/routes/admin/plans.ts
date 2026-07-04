import { Hono } from "hono"
import { z } from "zod"
import { requirePermission } from "../../middleware/admin-auth"
import { writeAudit } from "../../services/audit"
import { listPlans, createPlan, updatePlan } from "../../services/admin/admin-plans"
import { getConfig, getConfigs, setConfig } from "../../services/config"
import type { AdminUser } from "../../db/schema"

// 套餐&配置页（spec310）：plans 写=plan.write；billing_configs 写=config.write（审计在 route 层显式做前后值）。
export const plansRouter = new Hono<{ Variables: { admin: AdminUser } }>()

// —— 配置区（同一张 billing_configs；GET 全量 / PUT 单 key）——
// 注意：/configs 必须在 /:id 之前注册，否则 "configs" 会被当作 plan id 匹配。
plansRouter.get("/configs", async (c) => c.json(await getConfigs(c.req.query("prefix") || undefined)))
const ConfigBody = z.object({ value: z.unknown() })
plansRouter.put("/configs/:key", requirePermission("config.write"), async (c) => {
  const key = c.req.param("key")
  const parsed = ConfigBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
  const before = await getConfig(key) // 审计前值 → 纯写 → 后值
  await setConfig(key, parsed.data.value)
  await writeAudit({ operator: c.var.admin.username, action: "config.write", target: `config:${key}`, before, after: parsed.data.value })
  return c.json({ ok: true })
})

// —— 套餐区 ——
plansRouter.get("/", async (c) => c.json(await listPlans()))
const CreateBody = z.object({
  name: z.string().min(1),
  code: z.string().optional(),
  priceCents: z.number().int().nonnegative().optional(),
  currency: z.string().optional(),
  billingCycle: z.string().min(1),
  grantCreditsPerCycle: z.number().int().nonnegative().optional(),
  features: z.record(z.string(), z.unknown()).optional(),
  limits: z.record(z.string(), z.unknown()).optional(),
})
plansRouter.post("/", requirePermission("plan.write"), async (c) => {
  const parsed = CreateBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
  return c.json(await createPlan(parsed.data, { operator: c.var.admin.username }))
})
const UpdateBody = z.object({
  priceCents: z.number().int().nonnegative().optional(),
  grantCreditsPerCycle: z.number().int().nonnegative().optional(),
  status: z.enum(["active", "archived"]).optional(),
  features: z.record(z.string(), z.unknown()).optional(),
  limits: z.record(z.string(), z.unknown()).optional(),
})
plansRouter.put("/:id", requirePermission("plan.write"), async (c) => {
  const parsed = UpdateBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
  return c.json(await updatePlan(c.req.param("id"), parsed.data, { operator: c.var.admin.username }))
})
