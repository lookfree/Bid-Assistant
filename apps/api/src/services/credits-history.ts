import { eq, sql, desc } from "drizzle-orm"
import { getDb } from "../db/client"
import { creditTransactions } from "../db/schema"

// 积分流水分页（spec308，只读）：按 createdAt desc，用户隔离。金额带符号原样透传（±）。
// type 忠实反映 DB 白名单（含 spec306 的 refund_clawback）。

export interface CreditTxView {
  id: string
  type: "grant" | "purchase" | "hold" | "settle" | "release" | "expire" | "referral_reward" | "refund_clawback"
  amount: number // 带符号 ±
  ref: string | null
  expireAt: string | null // ISO
  createdAt: string // ISO
}

export async function listCreditTransactions(
  userId: string,
  opts: { page: number; pageSize: number; offset: number },
): Promise<{ items: CreditTxView[]; total: number }> {
  const db = getDb()
  // 行与总数互不依赖，并行取（省往返）
  const [rows, [c]] = await Promise.all([
    db
      .select({
        id: creditTransactions.id,
        type: creditTransactions.type,
        amount: creditTransactions.amount,
        ref: creditTransactions.ref,
        expireAt: creditTransactions.expireAt,
        createdAt: creditTransactions.createdAt,
      })
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, userId))
      .orderBy(desc(creditTransactions.createdAt))
      .limit(opts.pageSize)
      .offset(opts.offset),
    db.select({ n: sql<number>`count(*)` }).from(creditTransactions).where(eq(creditTransactions.userId, userId)),
  ])
  return {
    items: rows.map((r) => ({
      id: r.id,
      type: r.type as CreditTxView["type"],
      amount: r.amount,
      ref: r.ref,
      expireAt: r.expireAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    total: Number(c?.n ?? 0),
  }
}
