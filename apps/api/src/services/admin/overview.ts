import { and, eq, gte, sql } from "drizzle-orm"
import { getDb } from "../../db/client"
import { users, subscriptions, paymentOrders, creditTransactions, bidProjects } from "../../db/schema"

// 概览指标聚合（spec310）：并行聚合 SQL，单次往返多查。
export interface OverviewMetrics {
  totalUsers: number
  payingUsers: number
  todayRevenueCents: number
  creditTxCount: number
  creditTxSumToday: number
  activeProjects: number
}

export async function computeOverview(): Promise<OverviewMetrics> {
  const db = getDb()
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const [[u], [p], [rev], [tx], [proj]] = await Promise.all([
    db.select({ n: sql<number>`count(*)` }).from(users),
    db.select({ n: sql<number>`count(distinct ${subscriptions.userId})` }).from(subscriptions).where(eq(subscriptions.status, "active")),
    db
      .select({ s: sql<number>`coalesce(sum(${paymentOrders.amountCents}),0)` })
      .from(paymentOrders)
      .where(and(eq(paymentOrders.status, "paid"), gte(paymentOrders.createdAt, todayStart))),
    db
      .select({ c: sql<number>`count(*)`, s: sql<number>`coalesce(sum(${creditTransactions.amount}),0)` })
      .from(creditTransactions)
      .where(gte(creditTransactions.createdAt, todayStart)),
    db.select({ n: sql<number>`count(*)` }).from(bidProjects).where(eq(bidProjects.status, "running")),
  ])
  return {
    totalUsers: Number(u!.n),
    payingUsers: Number(p!.n),
    todayRevenueCents: Number(rev!.s),
    creditTxCount: Number(tx!.c),
    creditTxSumToday: Number(tx!.s),
    activeProjects: Number(proj!.n),
  }
}
