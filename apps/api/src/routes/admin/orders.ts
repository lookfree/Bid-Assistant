import { Hono } from "hono"
import { z } from "zod"
import { requirePermission } from "../../middleware/admin-auth"
import { writeAudit } from "../../services/audit"
import { listOrders, getOrderDetail } from "../../services/admin/admin-orders"
import { createRefund, type RefundProvider } from "../../services/refunds"
import type { AdminUser } from "../../db/schema"

// 订单页（spec310）：列表/详情只读；退款审批单独收口为 /admin-api/refunds（refund.write + 审计 + spec306）。
export const ordersRouter = new Hono<{ Variables: { admin: AdminUser } }>()

ordersRouter.get("/", async (c) =>
  c.json(
    await listOrders({
      status: c.req.query("status") || undefined,
      type: c.req.query("type") || undefined,
      userId: c.req.query("userId") || undefined,
      page: Number(c.req.query("page") ?? 1),
      pageSize: Number(c.req.query("pageSize") ?? 20),
    }),
  ),
)
ordersRouter.get("/:id", async (c) => c.json(await getOrderDetail(c.req.param("id"))))

const RefundBody = z.object({ orderId: z.string().uuid(), amount: z.number().int().positive(), reason: z.string().min(1), allowNegativeBalance: z.boolean().optional() })

// 退款唯一入口（spec306 已删自建路由）：工厂注入 provider 解析器（生产从 env 解析、测试注入 mock）。
export function refundsRouter(resolveProvider: () => RefundProvider | undefined) {
  const r = new Hono<{ Variables: { admin: AdminUser } }>()
  r.post("/", requirePermission("refund.write"), async (c) => {
    const parsed = RefundBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
    const provider = resolveProvider()
    if (!provider) return c.json({ error: "payment_unconfigured" }, 503)
    try {
      const res = await createRefund(
        { orderId: parsed.data.orderId, amountCents: parsed.data.amount, reason: parsed.data.reason, operator: c.var.admin.username, allowNegativeBalance: parsed.data.allowNegativeBalance },
        { provider },
      )
      await writeAudit({
        operator: c.var.admin.username,
        action: "refund.write",
        target: `order:${parsed.data.orderId}`,
        before: { status: "paid" },
        after: { refundId: res.refundId, status: res.status, amountCents: parsed.data.amount },
      })
      return c.json(res)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 422)
    }
  })
  return r
}
