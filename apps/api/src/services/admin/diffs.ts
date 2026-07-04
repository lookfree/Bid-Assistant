import { and, eq, sql, type SQL } from "drizzle-orm"
import { getDb } from "../../db/client"
import { reconcileDiffs, paymentOrders } from "../../db/schema"
import { markPaid } from "../payment-orders"
import { writeAudit } from "../audit"

// 对账差异工作台（spec310，review-followups C12/C14）：列出 open 差异 → 人工处置 / unknown_paid 补入账。

export async function listDiffs(opts: { resolved?: string; diffType?: string; page?: number; pageSize?: number }) {
  const db = getDb()
  const page = opts.page ?? 1
  const pageSize = opts.pageSize ?? 20
  const conds: SQL[] = [eq(reconcileDiffs.resolved, opts.resolved ?? "open")] // 默认只看 open
  if (opts.diffType) conds.push(eq(reconcileDiffs.diffType, opts.diffType))
  const where = and(...conds)
  const [items, [cnt]] = await Promise.all([
    db.select().from(reconcileDiffs).where(where).orderBy(sql`${reconcileDiffs.createdAt} desc`).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)` }).from(reconcileDiffs).where(where),
  ])
  return { items, total: Number(cnt!.n) }
}

// 人工标记已处置（置 resolved）+ 审计留痕。
export async function resolveDiff(id: string, opts: { operator: string }) {
  const db = getDb()
  const [before] = await db.select().from(reconcileDiffs).where(eq(reconcileDiffs.id, id))
  if (!before) throw new Error("差异不存在")
  if (before.resolved !== "open") throw new Error("差异已处置")
  await db.update(reconcileDiffs).set({ resolved: "resolved" }).where(eq(reconcileDiffs.id, id))
  // 审计 action 用独立语义（权限仍由 route 层 refund.write 把关），不与真实退款混在同一 action 里便于过滤。
  await writeAudit({ operator: opts.operator, action: "diff.resolve", target: `diff:${id}`, before: { resolved: before.resolved }, after: { resolved: "resolved" } })
  return { ok: true }
}

// unknown_paid 修复：人工核实通道确已收款后，对订单调 markPaid(allowStale) 幂等补入账，再关闭差异。
export async function fixUnknownPaid(id: string, opts: { operator: string }) {
  const db = getDb()
  const [diff] = await db.select().from(reconcileDiffs).where(eq(reconcileDiffs.id, id))
  if (!diff) throw new Error("差异不存在")
  if (diff.resolved !== "open") throw new Error("差异已处置")
  if (diff.diffType !== "unknown_paid") throw new Error("仅 unknown_paid 差异可走此修复")
  if (!diff.orderId) throw new Error("差异未关联订单")
  const [order] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, diff.orderId))
  if (!order) throw new Error("订单不存在")
  // 人工确认通道已收款：按订单快照金额补入账（幂等，可能已超 7 天窗 → allowStale）
  const res = await markPaid(order.id, { tradeNo: diff.tradeNo ?? undefined, paidAmountCents: order.amountCents }, { allowStale: true })
  await db.update(reconcileDiffs).set({ resolved: "resolved" }).where(eq(reconcileDiffs.id, id))
  await writeAudit({ operator: opts.operator, action: "diff.fix_unknown_paid", target: `diff:${id}`, before: { resolved: "open", orderStatus: order.status }, after: { resolved: "resolved", markPaid: res } })
  return res
}
