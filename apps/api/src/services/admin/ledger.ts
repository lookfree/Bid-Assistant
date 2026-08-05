import { and, eq, inArray, sql, type SQL } from "drizzle-orm"
import { getDb } from "../../db/client"
import { creditTransactions, creditBalances, users, userIdentities } from "../../db/schema"
import { pagedResult } from "../../lib/pagination"
import { userDisplayName } from "../../lib/user-display"

// 账本页服务（spec310）：查流水（用户/type 过滤 + 分页）+ 余额=Σ流水核对（缓存 vs 实算）。
//
// userId 可省 ⇒ 全部用户视图（运营要的是「先看全局有没有异常流水，再点进具体的人」，
// 先选人才能看等于要求运营预先知道找谁）。此时每行必须带用户展示名，否则混在一起看不出是谁的。
export async function listLedger(opts: { userId?: string; type?: string; page?: number; pageSize?: number }) {
  const db = getDb()
  const page = opts.page ?? 1
  const pageSize = opts.pageSize ?? 20
  const conds: SQL[] = []
  if (opts.userId) conds.push(eq(creditTransactions.userId, opts.userId))
  if (opts.type) conds.push(eq(creditTransactions.type, opts.type))
  const where = conds.length ? and(...conds) : undefined
  const rows = await db
    .select({ tx: creditTransactions, nickname: users.nickname })
    .from(creditTransactions)
    .leftJoin(users, eq(users.id, creditTransactions.userId))
    .where(where)
    .orderBy(sql`${creditTransactions.createdAt} desc`)
    .limit(pageSize)
    .offset((page - 1) * pageSize)
  // 手机号在 user_identities（users 表没有该列），只为本页这几十行按 id 批量取一次。
  const ids = [...new Set(rows.map((r) => r.tx.userId))]
  const phones = ids.length
    ? await db
        .select({ userId: userIdentities.userId, identifier: userIdentities.identifier })
        .from(userIdentities)
        .where(and(eq(userIdentities.provider, "phone"), inArray(userIdentities.userId, ids)))
    : []
  const phoneMap = new Map(phones.map((p) => [p.userId, p.identifier]))
  return pagedResult(
    Promise.resolve(
      rows.map((r) => ({
        ...r.tx,
        userName: userDisplayName({ id: r.tx.userId, nickname: r.nickname, phone: phoneMap.get(r.tx.userId) }),
      })),
    ),
    db.select({ n: sql<number>`count(*)` }).from(creditTransactions).where(where),
  )
}

// 余额核对：缓存 credit_balances vs Σ流水（单用户版对账，复用 spec306 思路）。
export async function checkBalance(userId: string) {
  const db = getDb()
  const [s] = await db
    .select({ actual: sql<number>`coalesce(sum(${creditTransactions.amount}),0)` })
    .from(creditTransactions)
    .where(eq(creditTransactions.userId, userId))
  const [b] = await db.select().from(creditBalances).where(eq(creditBalances.userId, userId))
  const actual = Number(s?.actual ?? 0)
  const cached = b?.balance ?? 0
  return { userId, cached, actual, consistent: cached === actual }
}
