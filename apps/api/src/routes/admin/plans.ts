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

// spec327：两个钱相关键加白名单形状校验（其它键保持宽松直存，行为不变）——防运营拼错键名/填坏值
// 静默进库、在发奖路径才炸。未命中此表的键沿用原逻辑，不做形状校验。
const CONFIG_SCHEMAS: Record<string, z.ZodTypeAny> = {
  referral_rules: z
    .object({
      inviterReward: z.number().int().nonnegative(),
      inviteeReward: z.number().int().nonnegative(),
      unlockOn: z.enum(["", "invitee_first_paid"]),
      capPerUser: z.number().int().nonnegative(),
      riskMaxPerIpPerHour: z.number().int().min(1),
      abandonDays: z.number().int().nonnegative(), // 新增：注册即弃闸门天数，0=关闭（spec327 Task C 消费）
    })
    .strict() // 拒绝未知键：防运营拼错键名（如写成 inviterRewards）静默失效
    .refine((v) => v.capPerUser >= Math.max(v.inviterReward, v.inviteeReward), {
      message: "capPerUser_must_be_at_least_max_reward",
    }),
  reward_expire_days: z.number().int().nonnegative(),
  signup_grant_credits: z.number().int().nonnegative(), // 注册赠送积分（0=不送）
  grant_expire_days: z.number().int().nonnegative(), // 赠送积分有效期天数（0=不过期）
}

plansRouter.put("/configs/:key", requirePermission("config.write"), async (c) => {
  const key = c.req.param("key")
  const parsed = ConfigBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
  const shape = CONFIG_SCHEMAS[key]
  if (shape && !shape.safeParse(parsed.data.value).success) return c.json({ error: "invalid_input" }, 400) // 命中白名单键先校验，坏值绝不写库
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
