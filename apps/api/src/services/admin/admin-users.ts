import { and, eq, ilike, or, inArray, sql } from "drizzle-orm"
import { getDb } from "../../db/client"
import { users, subscriptions, userIdentities } from "../../db/schema"
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
  // 列表页需要手机号（user_identities）、会员档（subscription→plans.code）、余额（credit_balances 缓存）——
  // 相关子查询按需取，避免 N+1；tier/phone/balance 缺省为 null/0（未绑手机/无订阅/无流水）。
  return pagedResult(
    db
      .select({
        id: users.id,
        status: users.status,
        nickname: users.nickname,
        createdAt: users.createdAt,
        phone: sql<string | null>`(select ui.identifier from user_identities ui where ui.user_id = ${users.id} and ui.provider = 'phone' limit 1)`,
        tier: sql<string | null>`(select p.code from subscriptions s join plans p on p.id = s.plan_id where s.user_id = ${users.id} and s.status = 'active' limit 1)`,
        balance: sql<number>`coalesce((select b.balance from credit_balances b where b.user_id = ${users.id}), 0)`,
      })
      .from(users)
      .where(where)
      .orderBy(users.createdAt)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)` }).from(users).where(where),
  )
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
