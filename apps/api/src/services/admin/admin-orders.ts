import { and, eq, sql, type SQL } from "drizzle-orm"
import { getDb } from "../../db/client"
import { paymentOrders, refunds } from "../../db/schema"

// 订单页服务（spec310）：列表（状态/类型/用户过滤）+ 详情（含关联退款）。退款走 route 层 spec306 createRefund。
export async function listOrders(opts: { status?: string; type?: string; userId?: string; page?: number; pageSize?: number }) {
  const db = getDb()
  const page = opts.page ?? 1
  const pageSize = opts.pageSize ?? 20
  const conds: SQL[] = []
  if (opts.status) conds.push(eq(paymentOrders.status, opts.status))
  if (opts.type) conds.push(eq(paymentOrders.type, opts.type))
  if (opts.userId) conds.push(eq(paymentOrders.userId, opts.userId))
  const where = conds.length ? and(...conds) : undefined
  const [items, [cnt]] = await Promise.all([
    db.select().from(paymentOrders).where(where).orderBy(sql`${paymentOrders.createdAt} desc`).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)` }).from(paymentOrders).where(where),
  ])
  return { items, total: Number(cnt!.n), page, pageSize }
}

export async function getOrderDetail(id: string) {
  const db = getDb()
  const [o] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, id))
  if (!o) throw new Error("订单不存在")
  const rs = await db.select().from(refunds).where(eq(refunds.orderId, id))
  return { ...o, refunds: rs }
}
