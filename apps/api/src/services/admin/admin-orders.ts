import { and, eq, inArray, sql, type SQL } from "drizzle-orm"
import { getDb } from "../../db/client"
import { paymentOrders, refunds, plans, users, userIdentities } from "../../db/schema"
import { pagedResult } from "../../lib/pagination"
import { userDisplayName } from "../../lib/user-display"

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
  // 带上套餐名：库里只有 plan_id（UUID），运营在订单页看不出"开通的是哪个会员"。
  // cycle_snapshot / credits_snapshot 本就在行里（select 全列），一并透出给前端渲染。
  const rows = await db
    .select({ o: paymentOrders, planName: plans.name, nickname: users.nickname })
    .from(paymentOrders)
    .leftJoin(plans, eq(plans.id, paymentOrders.planId))
    .leftJoin(users, eq(users.id, paymentOrders.userId))
    .where(where)
    .orderBy(sql`${paymentOrders.createdAt} desc`)
    .limit(pageSize)
    .offset((page - 1) * pageSize)
  const nameOf = await displayNames(rows.map((r) => ({ userId: r.o.userId, nickname: r.nickname })))
  return pagedResult(
    Promise.resolve(rows.map((r) => ({ ...r.o, planName: r.planName ?? null, userName: nameOf(r.o.userId) }))),
    db.select({ n: sql<number>`count(*)` }).from(paymentOrders).where(where),
  )
}

// 退款前要确认「这笔是谁的」：只有 user_id（UUID）时运营得逐单去用户页反查，很容易退错人。
// 手机号在 user_identities（users 表没有该列），只为本页这几十行按 id 批量取一次（同 listLedger）。
async function displayNames(rows: { userId: string; nickname: string | null }[]) {
  const db = getDb()
  const ids = [...new Set(rows.map((r) => r.userId))]
  const phones = ids.length
    ? await db
        .select({ userId: userIdentities.userId, identifier: userIdentities.identifier })
        .from(userIdentities)
        .where(and(eq(userIdentities.provider, "phone"), inArray(userIdentities.userId, ids)))
    : []
  const phoneMap = new Map(phones.map((p) => [p.userId, p.identifier]))
  const nickMap = new Map(rows.map((r) => [r.userId, r.nickname]))
  return (userId: string) =>
    userDisplayName({ id: userId, nickname: nickMap.get(userId), phone: phoneMap.get(userId) })
}

export async function getOrderDetail(id: string) {
  const db = getDb()
  const [row] = await db
    .select({ o: paymentOrders, planName: plans.name })
    .from(paymentOrders)
    .leftJoin(plans, eq(plans.id, paymentOrders.planId))
    .where(eq(paymentOrders.id, id))
  if (!row) throw new Error("订单不存在")
  const o = { ...row.o, planName: row.planName ?? null }
  const rs = await db.select().from(refunds).where(eq(refunds.orderId, id))
  return { ...o, refunds: rs }
}
