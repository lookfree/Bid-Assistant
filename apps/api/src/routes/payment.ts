import { randomUUID } from "node:crypto"
import { Hono } from "hono"
import { z } from "zod"
import { and, eq } from "drizzle-orm"
import { getDb } from "../db/client"
import { paymentOrders } from "../db/schema"
import type { User } from "../db/schema"
import { authMiddleware } from "../middleware/auth"
import { getConfig } from "../services/config"
import { createOrder, markPaid, pollUntilFinal } from "../services/payment-orders"
import { getPayment } from "../services/payment"
import type { PaymentProvider } from "../services/payment/provider"

// 支付路由（架构 §6.1）：下单 → 跳转支付 URL（前端转二维码）→ 回调验签 + 后台轮询双通道 → 只入账一次。
// 钱只在这一层动（§3.2）；金额/到账积分一律服务端从配置取快照，客户端字段全部忽略。

type RechargePack = { id: string; amountCents: number; credits: number }

export type PaymentRouteDeps = {
  provider: PaymentProvider
  baseUrl: string // 公网基址：notify_url / return_url 用（env PAYMENT_NOTIFY_BASE_URL）
  poll: (orderId: string) => void // 后台轮询启动器（fire-and-forget；测试注入捕获）
}

export function paymentRoutes(deps: Partial<PaymentRouteDeps> = {}) {
  const assembled = deps.provider ? undefined : getPayment()
  const provider = deps.provider ?? assembled?.provider
  const baseUrl = deps.baseUrl ?? process.env.PAYMENT_NOTIFY_BASE_URL ?? ""
  const poll =
    deps.poll ??
    ((orderId: string) => {
      if (!provider) return
      void pollUntilFinal(orderId, { provider }).catch((err) => console.error(`[payment] 轮询异常 order=${orderId}`, err))
    })

  const r = new Hono<{ Variables: { user: User } }>()

  // 凭据未配置的环境：支付能力整体关闭（503），不半开
  if (!provider) {
    r.all("*", (c) => c.json({ error: "payment_unconfigured" }, 503))
    return r
  }

  // —— 回调（收钱吧服务器调用，无用户鉴权，验签放行）——
  r.post("/shouqianba/notify", async (c) => {
    const rawBody = await c.req.text() // RSA 被签内容是 body 原文，必须先取 text
    const authorization = c.req.header("Authorization") ?? ""
    if (!provider.verifyCallback(rawBody, authorization)) return c.json({ error: "bad_signature" }, 403)

    const parsed = z
      .object({
        client_sn: z.string().min(1),
        order_status: z.string().optional(),
        sn: z.string().optional(),
        trade_no: z.string().optional(),
        payway: z.string().optional(),
        total_amount: z.string().optional(),
      })
      .safeParse(JSON.parse(rawBody))
    if (!parsed.success) return c.json({ error: "bad_body" }, 400)
    const cb = parsed.data

    const [order] = await getDb().select().from(paymentOrders).where(eq(paymentOrders.clientSn, cb.client_sn))
    if (!order) return c.json({ error: "order_not_found" }, 404)

    if (cb.order_status === "PAID") {
      // 金额不符/重复回调都在 markPaid 内兜底（不入账/no-op）；一律回 success 停止重发，差异走对账
      await markPaid(order.id, {
        sn: cb.sn,
        tradeNo: cb.trade_no,
        payway: cb.payway,
        paidAmountCents: cb.total_amount != null ? Number(cb.total_amount) : undefined,
      })
    }
    return c.text("success")
  })

  // —— 以下路由需登录 ——
  r.use("*", authMiddleware)

  // 充值下单：客户端只传 packId，金额/到账积分服务端从配置取并快照进订单
  r.post("/recharge", async (c) => {
    const parsed = z.object({ packId: z.string().min(1) }).safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
    const packs = (await getConfig<RechargePack[]>("recharge_packs")) ?? []
    const pack = packs.find((p) => p.id === parsed.data.packId)
    if (!pack) return c.json({ error: "invalid_pack" }, 400)

    const userId = c.get("user").id
    const order = await createOrder({
      userId,
      type: "recharge",
      amountCents: pack.amountCents,
      creditsSnapshot: pack.credits, // 到账以下单快照为准（运营改包不影响在途单）
      idempotencyKey: `recharge:${userId}:${randomUUID()}`,
    })
    const { payUrl } = await provider.createPayment({
      clientSn: order.clientSn,
      amountCents: pack.amountCents,
      subject: "积分充值",
      returnUrl: `${baseUrl}/pay/result?orderId=${order.id}`,
      notifyUrl: `${baseUrl}/api/payment/shouqianba/notify`,
    })
    poll(order.id) // 回调 + 轮询双通道取终态
    return c.json({ orderId: order.id, payUrl })
  })

  // 订单状态（前端支付页轮询显示用）：本人可查
  r.get("/orders/:id", async (c) => {
    const [order] = await getDb()
      .select()
      .from(paymentOrders)
      .where(and(eq(paymentOrders.id, c.req.param("id")), eq(paymentOrders.userId, c.get("user").id)))
    if (!order) return c.json({ error: "not_found" }, 404)
    return c.json({ id: order.id, status: order.status, type: order.type, amountCents: order.amountCents, createdAt: order.createdAt })
  })

  return r
}
