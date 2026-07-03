import { randomUUID } from "node:crypto"
import { Hono } from "hono"
import { z } from "zod"
import { and, eq } from "drizzle-orm"
import { getDb } from "../db/client"
import { plans } from "../db/schema"
import type { User } from "../db/schema"
import { authMiddleware } from "../middleware/auth"
import { createOrder, pollUntilFinal } from "../services/payment-orders"
import { getPayment } from "../services/payment"
import { launchPayment, type PaymentRouteDeps } from "./payment"

// 会员路由（架构 §6.2，spec305）：手动续费下单 → 复用 spec304 单笔支付链路。
// 服务端定价：客户端只传 planId，金额从 plans 当前价取并快照进订单；无任何签约/代扣路径。
// spec308 会员中心的套餐列表/我的会员页在此文件扩展。

export function membershipRoutes(deps: Partial<PaymentRouteDeps> = {}) {
  const assembled = deps.provider ? undefined : getPayment()
  const provider = deps.provider ?? assembled?.provider
  const baseUrl = deps.baseUrl ?? assembled?.baseUrl

  const r = new Hono<{ Variables: { user: User } }>()

  // 凭据未配置的环境：支付能力整体关闭（503），gate 与 payment 路由同源 getPayment（不半开）
  if (!provider || !baseUrl) {
    r.all("*", (c) => c.json({ error: "payment_unconfigured" }, 503))
    return r
  }
  const poll =
    deps.poll ??
    ((orderId: string) => {
      void pollUntilFinal(orderId, { provider }).catch((err) => console.error(`[membership] 轮询异常 order=${orderId}`, err))
    })

  r.use("*", authMiddleware)

  // 手动续费下单：金额=所选套餐当期价（服务端取价），支付成功由 markPaid renewal 分支续期+发当期积分
  r.post("/renew", async (c) => {
    const parsed = z.object({ planId: z.string().uuid() }).safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
    const [plan] = await getDb()
      .select()
      .from(plans)
      .where(and(eq(plans.id, parsed.data.planId), eq(plans.status, "active"))) // 下架套餐不可续
    if (!plan) return c.json({ error: "invalid_plan" }, 400)
    if (!Number.isInteger(plan.priceCents) || plan.priceCents <= 0) {
      console.error(`[membership] plans 定价非法 plan=${plan.id} price=${plan.priceCents}，拒绝下单`)
      return c.json({ error: "plan_misconfigured" }, 500) // 配置事故：宁可下单失败，不可错价收钱
    }

    const userId = c.get("user").id
    const order = await createOrder({
      userId,
      type: "renewal",
      amountCents: plan.priceCents, // 价格以下单快照为准（运营改价不影响在途单）
      planId: plan.id,
      idempotencyKey: `renewal:${userId}:${randomUUID()}`,
    })
    return c.json(await launchPayment({ provider, baseUrl, poll }, order, `会员续费-${plan.name}`, plan.priceCents))
  })

  return r
}
