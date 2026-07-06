import { and, eq, ilike, or, inArray, sql } from "drizzle-orm"
import { getDb } from "../../db/client"
import { users, subscriptions, userIdentities, plans, creditBalances } from "../../db/schema"
import { adminAdjust, getBalance } from "../credits"
import { writeAudit } from "../audit"
import { pagedResult } from "../../lib/pagination"

// 用户页服务（spec310）：列表/搜索/详情/封禁解封/手动调积分。
// 注意：C 端 users 无 email 字段——搜索匹配 nickname 或 user_identities.identifier（手机/微信）。

export async function listUsers(opts: { q?: string; page?: number; pageSize?: number }) {
  const db = getDb()
  const page = opts.page ?? 1
  const pageSize = opts.pageSize ?? 20
  const where = opts.q
    ? or(
        ilike(users.nickname, `%${opts.q}%`),
        inArray(
          users.id,
          db.select({ id: userIdentities.userId }).from(userIdentities).where(ilike(userIdentities.identifier, `%${opts.q}%`)),
        ),
      )
    : undefined
  const { items, total } = await pagedResult(
    db.select().from(users).where(where).orderBy(users.createdAt).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)` }).from(users).where(where),
  )
  const ids = items.map((u) => u.id)
  if (ids.length === 0) return { items: [] as (typeof items[number] & { phone: string | null; tier: string | null; balance: number })[], total }
  // 列表页补全手机号（user_identities）/ 会员档（subscription→plans.code）/ 余额（credit_balances 缓存）——
  // 各一条按 id 批量查，避免相关子查询列歧义与 N+1；缺省 null/0（未绑手机/无订阅/无流水）。
  const [phones, subs, bals] = await Promise.all([
    db
      .select({ userId: userIdentities.userId, identifier: userIdentities.identifier })
      .from(userIdentities)
      .where(and(eq(userIdentities.provider, "phone"), inArray(userIdentities.userId, ids))),
    db
      .select({ userId: subscriptions.userId, code: plans.code })
      .from(subscriptions)
      .innerJoin(plans, eq(plans.id, subscriptions.planId))
      .where(and(eq(subscriptions.status, "active"), inArray(subscriptions.userId, ids))),
    db.select({ userId: creditBalances.userId, balance: creditBalances.balance }).from(creditBalances).where(inArray(creditBalances.userId, ids)),
  ])
  const phoneMap = new Map(phones.map((p) => [p.userId, p.identifier]))
  const tierMap = new Map(subs.map((s) => [s.userId, s.code]))
  const balMap = new Map(bals.map((b) => [b.userId, b.balance]))
  return {
    items: items.map((u) => ({ ...u, phone: phoneMap.get(u.id) ?? null, tier: tierMap.get(u.id) ?? null, balance: balMap.get(u.id) ?? 0 })),
    total,
  }
}

export async function getUserDetail(id: string) {
  const db = getDb()
  const [u] = await db.select().from(users).where(eq(users.id, id))
  if (!u) throw new Error("用户不存在")
  const [sub] = await db.select().from(subscriptions).where(and(eq(subscriptions.userId, id), eq(subscriptions.status, "active")))
  const [ph] = await db
    .select({ identifier: userIdentities.identifier })
    .from(userIdentities)
    .where(and(eq(userIdentities.userId, id), eq(userIdentities.provider, "phone")))
    .limit(1)
  const [tierRow] = sub ? await db.select({ code: plans.code }).from(plans).where(eq(plans.id, sub.planId)) : []
  const balance = await getBalance(id)
  // phone/tier 与 listUsers、ApiUserDetail 契约对齐（详情也带手机号/会员档）
  return { ...u, phone: ph?.identifier ?? null, tier: tierRow?.code ?? null, subscription: sub ?? null, balance }
}

// 封禁/解封同属 user.write 权限；读旧 status → 更新 → 审计前后值。
async function setUserStatus(id: string, status: "active" | "banned", operator: string) {
  const db = getDb()
  const [u] = await db.select().from(users).where(eq(users.id, id))
  if (!u) throw new Error("用户不存在")
  await db.update(users).set({ status }).where(eq(users.id, id))
  await writeAudit({ operator, action: "user.write", target: `user:${id}`, before: { status: u.status }, after: { status } })
}

export const banUser = (id: string, opts: { operator: string }) => setUserStatus(id, "banned", opts.operator)
export const unbanUser = (id: string, opts: { operator: string }) => setUserStatus(id, "active", opts.operator)

// 手动调积分：走 spec302 credits.adminAdjust（签名金额，负向即扣减；grant 不收负值）+ 审计前后余额。
// 幂等键由调用方（前端每次调整生成一个稳定 UUID）提供——用时间戳会让双击/重试各生成新键 → 重复入账。
export async function adminGrantCredits(id: string, opts: { amount: number; reason: string; operator: string; idempotencyKey: string }) {
  const before = await getBalance(id)
  await adminAdjust(id, opts.amount, { ref: `admin:${opts.reason}`, idempotencyKey: `admin:${opts.idempotencyKey}` })
  const after = await getBalance(id)
  await writeAudit({
    operator: opts.operator,
    action: "credit.adjust",
    target: `user:${id}`,
    before: { balance: before },
    after: { balance: after, amount: opts.amount, reason: opts.reason },
  })
  return { balance: after }
}
