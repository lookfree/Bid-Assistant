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

export interface TrendPoint {
  date: string // MM/DD
  revenue: number // 元
  credits: number // 当日积分流水净额
}

/** 近 days 天每日营收（已支付单，元）+ 积分流水净额，补齐连续日期（无数据补 0）。趋势图用。 */
export async function computeTrend(days = 14): Promise<TrendPoint[]> {
  const db = getDb()
  const since = new Date()
  since.setHours(0, 0, 0, 0)
  since.setDate(since.getDate() - (days - 1))
  // SQL 与 JS 都锚定同一时区(Asia/Shanghai)分桶,否则 to_char(会话TZ) 与 new Date(NodeTZ) 会把
  // 临近午夜的单归到不同日 → 边界日数据丢失/错位。
  const TZ = "Asia/Shanghai"
  // TZ 必须内联为 SQL 字面量，不能走绑定参数：${TZ} 会让 SELECT 与 GROUP BY 各得一个不同占位符
  // ($1 vs $2)，Postgres 视为不同表达式 → "must appear in the GROUP BY clause" 报错（趋势接口 500）。
  const dayExpr = (col: unknown) => sql<string>`to_char(${col} AT TIME ZONE 'Asia/Shanghai', 'MM/DD')`
  const fmtDay = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "2-digit", day: "2-digit" })
  const [rev, cr] = await Promise.all([
    db
      .select({ d: dayExpr(paymentOrders.createdAt), s: sql<number>`coalesce(sum(${paymentOrders.amountCents}),0)` })
      .from(paymentOrders)
      .where(and(eq(paymentOrders.status, "paid"), gte(paymentOrders.createdAt, since)))
      .groupBy(dayExpr(paymentOrders.createdAt)),
    db
      .select({ d: dayExpr(creditTransactions.createdAt), s: sql<number>`coalesce(sum(${creditTransactions.amount}),0)` })
      .from(creditTransactions)
      .where(gte(creditTransactions.createdAt, since))
      .groupBy(dayExpr(creditTransactions.createdAt)),
  ])
  const revMap = new Map(rev.map((r) => [r.d, Number(r.s)]))
  const crMap = new Map(cr.map((r) => [r.d, Number(r.s)]))
  const out: TrendPoint[] = []
  const d = new Date(since)
  for (let i = 0; i < days; i++) {
    const key = fmtDay.format(d) // MM/DD in TZ，与 SQL to_char(... AT TIME ZONE TZ) 对齐
    out.push({ date: key, revenue: Math.round((revMap.get(key) ?? 0) / 100), credits: crMap.get(key) ?? 0 })
    d.setDate(d.getDate() + 1)
  }
  return out
}
