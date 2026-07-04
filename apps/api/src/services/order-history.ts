import { eq, sql, desc } from "drizzle-orm"
import { getDb } from "../db/client"
import { paymentOrders } from "../db/schema"
import { centsToYuan } from "../lib/money"

// 我的订单分页（spec308，只读）：按 createdAt desc，用户隔离。amountCents→amountYuan 一致换算。
// status 忠实反映 DB 白名单（含 unknown 在途态）。

export interface OrderView {
  id: string
  type: "recharge" | "purchase" | "renewal"
  amountCents: number
  amountYuan: number
  status: "created" | "paid" | "failed" | "unknown" | "refunded"
  provider: string
  createdAt: string // ISO
}

export async function listOrders(
  userId: string,
  opts: { page: number; pageSize: number; offset: number },
): Promise<{ items: OrderView[]; total: number }> {
  const db = getDb()
  const rows = await db
    .select({
      id: paymentOrders.id,
      type: paymentOrders.type,
      amountCents: paymentOrders.amountCents,
      status: paymentOrders.status,
      provider: paymentOrders.provider,
      createdAt: paymentOrders.createdAt,
    })
    .from(paymentOrders)
    .where(eq(paymentOrders.userId, userId))
    .orderBy(desc(paymentOrders.createdAt))
    .limit(opts.pageSize)
    .offset(opts.offset)
  const [c] = await db
    .select({ n: sql<number>`count(*)` })
    .from(paymentOrders)
    .where(eq(paymentOrders.userId, userId))
  return {
    items: rows.map((r) => ({
      id: r.id,
      type: r.type as OrderView["type"],
      amountCents: r.amountCents,
      amountYuan: centsToYuan(r.amountCents),
      status: r.status as OrderView["status"],
      provider: r.provider,
      createdAt: r.createdAt.toISOString(),
    })),
    total: Number(c?.n ?? 0),
  }
}
