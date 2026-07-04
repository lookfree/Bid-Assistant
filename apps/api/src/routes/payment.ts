import { randomUUID } from "node:crypto"
import { Hono, type Context } from "hono"
import { z } from "zod"
import { and, eq } from "drizzle-orm"
import { getDb } from "../db/client"
import { paymentOrders } from "../db/schema"
import type { User } from "../db/schema"
import { authMiddleware } from "../middleware/auth"
import { getConfig } from "../services/config"
import { countOpenOrders, createOrder, markPaid, pollUntilFinal } from "../services/payment-orders"
import { getPayment } from "../services/payment"
import type { PaymentProvider, Payway } from "../services/payment/provider"

// 支付路由（架构 §6.1）：下单 → 跳转支付 URL（前端转二维码）→ 回调验签 + 后台轮询双通道 → 只入账一次。
// 钱只在这一层动（§3.2）；金额/到账积分一律服务端从配置取快照，客户端字段全部忽略。
// 通道报文解析/金额归一在 provider.parseCallback 内完成——路由不接触通道线格式。

type RechargePack = { id: string; amountCents: number; credits: number }

/** 充值包配置校验：金额/积分必须正整数。配置错误静默放行是资损（收钱不发积分/浮点炸单）。 */
function validPack(p: RechargePack | undefined): p is RechargePack {
  return p != null && Number.isInteger(p.amountCents) && p.amountCents > 0 && Number.isInteger(p.credits) && p.credits > 0
}

export type PaymentRouteDeps = {
  provider: PaymentProvider
  baseUrl: string // 公网基址：notify_url / return_url 用（env PAYMENT_NOTIFY_BASE_URL）
  poll: (orderId: string) => void // 后台轮询启动器（fire-and-forget；测试注入捕获）
}

/** 解析路由依赖（deps 覆盖 > getPayment 装配）：缺 provider/baseUrl → undefined，调用方整体 503 不半开。 */
export function resolvePaymentDeps(deps: Partial<PaymentRouteDeps>, logTag: string): PaymentRouteDeps | undefined {
  const assembled = deps.provider ? undefined : getPayment()
  const provider = deps.provider ?? assembled?.provider
  const baseUrl = deps.baseUrl ?? assembled?.baseUrl
  if (!provider || !baseUrl) return undefined
  const poll =
    deps.poll ??
    ((orderId: string) => {
      void pollUntilFinal(orderId, { provider }).catch((err) => console.error(`[${logTag}] 轮询异常 order=${orderId}`, err))
    })
  return { provider, baseUrl, poll }
}

/** 用户开放订单上限：防刷单（每单都产生网关调用 + 6 分钟轮询，无限建单是对通道配额的放大攻击）。 */
export const MAX_OPEN_ORDERS_PER_USER = 5

/** C 扫 B 下单入参校验：客户端二选一钱包（充值/续费共用）。 */
export const paywaySchema = z.enum(["alipay", "wechat"])

/** 建好订单 → 预下单出二维码 + 启动后台轮询（充值/续费下单共用的收尾）。 */
export async function launchPayment(
  deps: PaymentRouteDeps,
  order: { id: string; clientSn: string },
  subject: string,
  amountCents: number,
  payway: Payway,
): Promise<{ orderId: string; qrCode: string; qrImageUrl?: string }> {
  const { qrCode, qrImageUrl } = await deps.provider.createPayment({
    clientSn: order.clientSn,
    amountCents,
    subject,
    payway,
    notifyUrl: `${deps.baseUrl}/api/payment${deps.provider.notifyPath}`,
  })
  deps.poll(order.id) // 回调 + 轮询双通道取终态（进程重启由滞留单扫描 Cron 兜底）
  return { orderId: order.id, qrCode, qrImageUrl }
}

/** 通道回调处理（收钱吧服务器调用，无用户鉴权，验签放行）。 */
function notifyHandler(provider: PaymentProvider) {
  return async (c: Context) => {
    const rawBody = await c.req.text() // RSA 被签内容是 body 原文，必须先取 text
    const parsed = provider.parseCallback(rawBody, c.req.header("Authorization") ?? "")
    if (!parsed.ok) {
      return parsed.error === "bad_signature" ? c.json({ error: "bad_signature" }, 403) : c.json({ error: "bad_body" }, 400)
    }
    const [order] = await getDb().select().from(paymentOrders).where(eq(paymentOrders.clientSn, parsed.clientSn))
    if (!order) return c.json({ error: "order_not_found" }, 404)

    if (parsed.result.status === "paid") {
      // 金额缺失/不符（→unknown 待对账）、重复回调（already_final no-op）都在 markPaid 内兜底；
      // 一律回 success 停止重发——重发不会改变金额事实，差异走 spec306 对账
      const r = parsed.result
      const res = await markPaid(order.id, { sn: r.sn, tradeNo: r.tradeNo, payway: r.payway, paidAmountCents: r.totalAmountCents })
      if (!res.paid && res.reason === "already_final" && ["failed", "refunded"].includes(order.status)) {
        // 已收敛为终态的单收到 PAID：钱可能真到了而账进不去——必须留告警（人工/对账核实）
        console.error(`[payment] 终态订单收到 PAID 信号 order=${order.id} status=${order.status} sn=${r.sn ?? ""}，需人工核实`)
      }
    }
    return c.text("success")
  }
}

export function paymentRoutes(deps: Partial<PaymentRouteDeps> = {}) {
  const resolved = resolvePaymentDeps(deps, "payment")
  const r = new Hono<{ Variables: { user: User } }>()

  // 凭据未配置的环境：支付能力整体关闭（503），不半开（gate 与入口 Cron 同源 getPayment）
  if (!resolved) {
    r.all("*", (c) => c.json({ error: "payment_unconfigured" }, 503))
    return r
  }
  const { provider } = resolved

  r.post(provider.notifyPath, notifyHandler(provider))

  // —— 以下路由需登录 ——
  r.use("*", authMiddleware)

  // 充值下单：客户端只传 packId + payway（钱包）；金额/到账积分服务端从配置取并快照进订单
  r.post("/recharge", async (c) => {
    const parsed = z.object({ packId: z.string().min(1), payway: paywaySchema }).safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
    const packs = (await getConfig<RechargePack[]>("recharge_packs")) ?? []
    const pack = packs.find((p) => p.id === parsed.data.packId)
    if (!pack) return c.json({ error: "invalid_pack" }, 400)
    if (!validPack(pack)) {
      console.error(`[payment] recharge_packs 配置非法 pack=${JSON.stringify(pack)}，拒绝下单`)
      return c.json({ error: "pack_misconfigured" }, 500) // 配置事故：宁可下单失败，不可收钱不发积分
    }

    const userId = c.get("user").id
    if ((await countOpenOrders(userId)) >= MAX_OPEN_ORDERS_PER_USER) return c.json({ error: "too_many_open_orders" }, 429)
    const order = await createOrder({
      userId,
      type: "recharge",
      amountCents: pack.amountCents,
      creditsSnapshot: pack.credits, // 到账以下单快照为准（运营改包不影响在途单）
      idempotencyKey: `recharge:${userId}:${randomUUID()}`,
    })
    return c.json(await launchPayment(resolved, order, "积分充值", pack.amountCents, parsed.data.payway))
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
