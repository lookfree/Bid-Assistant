import { and, eq, sql, type SQL } from "drizzle-orm"
import { getDb } from "../../db/client"
import { creditTransactions, creditBalances } from "../../db/schema"

// 账本页服务（spec310）：按用户查流水（type 过滤 + 分页）+ 余额=Σ流水核对（缓存 vs 实算）。
export async function listLedger(opts: { userId: string; type?: string; page?: number; pageSize?: number }) {
  const db = getDb()
  const page = opts.page ?? 1
  const pageSize = opts.pageSize ?? 20
  const conds: SQL[] = [eq(creditTransactions.userId, opts.userId)]
  if (opts.type) conds.push(eq(creditTransactions.type, opts.type))
  const where = and(...conds)
  const [items, [cnt]] = await Promise.all([
    db.select().from(creditTransactions).where(where).orderBy(sql`${creditTransactions.createdAt} desc`).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)` }).from(creditTransactions).where(where),
  ])
  return { items, total: Number(cnt!.n), page, pageSize }
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
