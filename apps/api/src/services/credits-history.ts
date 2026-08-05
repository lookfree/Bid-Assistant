import { and, eq, ne, sql, desc } from "drizzle-orm"
import { getDb } from "../db/client"
import { creditTransactions } from "../db/schema"

// 积分流水分页（spec308，只读）：按 createdAt desc，用户隔离。金额带符号原样透传（±）。
// type 忠实反映 DB 白名单（含 spec306 的 refund_clawback）。

export interface CreditTxView {
  id: string
  // 逐项对齐 credit_tx_type_check（admin_adjust 此前漏了：运营后台可人工调整积分，
  // 漏在类型里会让读代码的人以为这种流水不会出现在用户侧）。
  type:
    | "grant" | "purchase" | "hold" | "settle" | "release"
    | "expire" | "referral_reward" | "refund_clawback" | "admin_adjust"
  amount: number // 带符号 ±
  ref: string | null
  expireAt: string | null // ISO
  createdAt: string // ISO
}

// 用户侧只看「余额真的动了」的流水：结算行记的是预扣与实际用量的差额，两者一致时就是 0
// （230 实测 190 条结算里 181 条为 0）——余额没动，对用户是纯噪音，还会把分页撑得七零八落
// （每页 10 条滤掉 9 条只剩 1 行）。**必须在 SQL 层滤**，否则 total 与页大小都对不上。
// 运营侧的账本审计（/admin-api/ledger）不做这个过滤：那是审计，要看全量。
const userVisible = (userId: string) =>
  and(eq(creditTransactions.userId, userId), ne(creditTransactions.amount, 0))!

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
      .where(userVisible(userId))
      .orderBy(desc(creditTransactions.createdAt))
      .limit(opts.pageSize)
      .offset(opts.offset),
    db.select({ n: sql<number>`count(*)` }).from(creditTransactions).where(userVisible(userId)),
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
