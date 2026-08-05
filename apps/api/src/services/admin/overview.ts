import { and, eq, gte, sql } from "drizzle-orm"
import { getDb } from "../../db/client"
import { users, subscriptions, paymentOrders, creditTransactions, bidProjects, refunds } from "../../db/schema"
import { beijingTodayStart } from "../../lib/beijing-day"

// 概览指标聚合（spec310）：并行聚合 SQL，单次往返多查。
export interface OverviewMetrics {
  totalUsers: number
  payingUsers: number
  /** 累计实收（已支付订单额 − 已完成退款额）：退了的钱不能算收入 */
  totalRevenueCents: number
  todayRevenueCents: number
  creditTxCount: number
  creditTxSumToday: number
  activeProjects: number
}

export async function computeOverview(): Promise<OverviewMetrics> {
  const db = getDb()
  // 「今日」按北京时间算，与容器时区无关（230 的 api 容器是 UTC，用本地零点会让「今天」
  // 从北京时间早八点起算）。趋势图早已锚定 Asia/Shanghai，这里对齐同一个日界。
  const todayStart = beijingTodayStart()
  // 营收一律按**实收**算：已支付订单额减去已完成退款额。只 sum 订单会把退掉的钱算进收入——
  // 全额退款的订单虽然会翻成 refunded 而不再计入，但**部分退款的订单仍是 paid**（有意如此，
  // 剩余额度还能继续退），那部分退款不减掉就是虚增。今日同理，按退款发生当天减。
  //
  // 减的时候必须 join 订单、只算**订单仍为 paid** 的那些退款：全额退款的订单已经翻成 refunded、
  // 本就不在上面的已支付合计里，再减一次就是扣两遍。230 实测（2026-08-05）：两笔全额退款共
  // 1100 分被重复扣，今日营收显示 ¥28.11、实际 ¥39.11。规则原本就写在上面这段注释里，SQL 没照做。
  const [[u], [p], [totalRev], [totalRefund], [rev], [todayRefund], [tx], [proj]] = await Promise.all([
    db.select({ n: sql<number>`count(*)` }).from(users),
    db.select({ n: sql<number>`count(distinct ${subscriptions.userId})` }).from(subscriptions).where(eq(subscriptions.status, "active")),
    db
      .select({ s: sql<number>`coalesce(sum(${paymentOrders.amountCents}),0)` })
      .from(paymentOrders)
      .where(eq(paymentOrders.status, "paid")),
    db
      .select({ s: sql<number>`coalesce(sum(${refunds.amountCents}),0)` })
      .from(refunds)
      .innerJoin(paymentOrders, eq(paymentOrders.id, refunds.orderId))
      .where(and(eq(refunds.status, "done"), eq(paymentOrders.status, "paid"))),
    db
      .select({ s: sql<number>`coalesce(sum(${paymentOrders.amountCents}),0)` })
      .from(paymentOrders)
      .where(and(eq(paymentOrders.status, "paid"), gte(paymentOrders.createdAt, todayStart))),
    db
      .select({ s: sql<number>`coalesce(sum(${refunds.amountCents}),0)` })
      .from(refunds)
      .innerJoin(paymentOrders, eq(paymentOrders.id, refunds.orderId))
      .where(and(eq(refunds.status, "done"), eq(paymentOrders.status, "paid"), gte(refunds.createdAt, todayStart))),
    db
      .select({ c: sql<number>`count(*)`, s: sql<number>`coalesce(sum(${creditTransactions.amount}),0)` })
      .from(creditTransactions)
      .where(gte(creditTransactions.createdAt, todayStart)),
    db.select({ n: sql<number>`count(*)` }).from(bidProjects).where(eq(bidProjects.status, "running")),
  ])
  return {
    totalUsers: Number(u!.n),
    payingUsers: Number(p!.n),
    totalRevenueCents: Number(totalRev!.s) - Number(totalRefund!.s),
    todayRevenueCents: Number(rev!.s) - Number(todayRefund!.s),
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
  // 起点同样取北京日零点：下面按 Asia/Shanghai 分桶，起点若用容器本地零点（UTC）会与分桶差 8 小时，
  // 首尾两天各缺一截。
  const since = new Date(beijingTodayStart().getTime() - (days - 1) * 24 * 3600 * 1000)
  // SQL 与 JS 都锚定同一时区(Asia/Shanghai)分桶,否则 to_char(会话TZ) 与 new Date(NodeTZ) 会把
  // 临近午夜的单归到不同日 → 边界日数据丢失/错位。
  const TZ = "Asia/Shanghai"
  // TZ 必须内联为 SQL 字面量，不能走绑定参数：${TZ} 会让 SELECT 与 GROUP BY 各得一个不同占位符
  // ($1 vs $2)，Postgres 视为不同表达式 → "must appear in the GROUP BY clause" 报错（趋势接口 500）。
  // sql.raw 内联同一个 TZ 常量（本地可信常量，无注入面）：JS 分桶与 SQL 分桶永远同源，改 TZ 不会漂移。
  const tzLiteral = sql.raw(`'${TZ}'`)
  const dayExpr = (col: unknown) => sql<string>`to_char(${col} AT TIME ZONE ${tzLiteral}, 'MM/DD')`
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
