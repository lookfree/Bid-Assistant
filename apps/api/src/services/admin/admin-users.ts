import { and, eq, ilike, or, inArray, sql } from "drizzle-orm"
import { getDb } from "../../db/client"
import { users, subscriptions, userIdentities } from "../../db/schema"
import { adminAdjust, getBalance } from "../credits"
import { writeAudit } from "../audit"

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
  const [items, [cnt]] = await Promise.all([
    db.select().from(users).where(where).orderBy(users.createdAt).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)` }).from(users).where(where),
  ])
  return { items, total: Number(cnt!.n), page, pageSize }
}

export async function getUserDetail(id: string) {
  const db = getDb()
  const [u] = await db.select().from(users).where(eq(users.id, id))
  if (!u) throw new Error("用户不存在")
  const [sub] = await db.select().from(subscriptions).where(and(eq(subscriptions.userId, id), eq(subscriptions.status, "active")))
  const balance = await getBalance(id)
  return { ...u, subscription: sub ?? null, balance }
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
export async function adminGrantCredits(id: string, opts: { amount: number; reason: string; operator: string; adminId: string }) {
  const before = await getBalance(id)
  await adminAdjust(id, opts.amount, {
    ref: `admin:${opts.reason}`,
    idempotencyKey: `admin:${opts.adminId}:${Date.now()}:${opts.amount}`,
  })
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
