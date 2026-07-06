import { Hono } from "hono"
import { z } from "zod"
import { requirePermission } from "../../middleware/admin-auth"
import { parsePagination, pagedBody } from "../../lib/pagination"
import { writeAudit } from "../../services/audit"
import { listOrders, getOrderDetail } from "../../services/admin/admin-orders"
import { createRefund, type RefundProvider } from "../../services/refunds"
import type { AdminUser } from "../../db/schema"

// 订单页（spec310）：列表/详情只读；退款审批单独收口为 /admin-api/refunds（refund.write + 审计 + spec306）。
export const ordersRouter = new Hono<{ Variables: { admin: AdminUser } }>()

ordersRouter.get("/", async (c) => {
  let pg
  try {
    pg = parsePagination(c.req.query())
  } catch {
    return c.json({ error: "invalid_pagination" }, 400)
  }
  const result = await listOrders({
    status: c.req.query("status") || undefined,
    type: c.req.query("type") || undefined,
    userId: c.req.query("userId") || undefined,
    page: pg.page,
    pageSize: pg.pageSize,
  })
  return c.json(pagedBody(pg, result))
})
ordersRouter.get("/:id", async (c) => c.json(await getOrderDetail(c.req.param("id"))))

const RefundBody = z.object({ orderId: z.string().uuid(), amount: z.number().int().positive(), reason: z.string().min(1), allowNegativeBalance: z.boolean().optional(), idempotencyKey: z.string().min(1).optional() })

// 退款唯一入口（spec306 已删自建路由）：工厂注入 provider 解析器（生产从 env 解析、测试注入 mock）。
export function refundsRouter(resolveProvider: () => RefundProvider | undefined) {
  const r = new Hono<{ Variables: { admin: AdminUser } }>()
  r.post("/", requirePermission("refund.write"), async (c) => {
    const parsed = RefundBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
    const provider = resolveProvider()
    if (!provider) return c.json({ error: "payment_unconfigured" }, 503)
    let res
    try {
      res = await createRefund(
        { orderId: parsed.data.orderId, amountCents: parsed.data.amount, reason: parsed.data.reason, operator: c.var.admin.username, allowNegativeBalance: parsed.data.allowNegativeBalance, idempotencyKey: parsed.data.idempotencyKey },
        { provider },
      )
    } catch (e) {
      return c.json({ error: (e as Error).message }, 422) // 仅退款本身失败才 422
    }
    // 退款已发生（真钱已动）：审计失败只记日志，绝不把成功的退款回报成失败 → 否则运营重试会二次退款。
    try {
      await writeAudit({
        operator: c.var.admin.username,
        action: "refund.write",
        target: `order:${parsed.data.orderId}`,
        before: { status: "paid" },
        after: { refundId: res.refundId, status: res.status, amountCents: parsed.data.amount },
      })
    } catch (e) {
      console.error(`[admin-refund] 审计写入失败（退款已成功，不影响结果）order=${parsed.data.orderId}`, e)
    }
    return c.json(res)
  })
  return r
}
