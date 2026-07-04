import { and, eq, gte, inArray, lt, lte, sql } from "drizzle-orm"
import { getDb } from "../db/client"
import { paymentOrders, refunds, reconcileDiffs, creditTransactions, creditBalances } from "../db/schema"
import * as credits from "./credits"
import { DAY_MS } from "./renewal"
import { STALE_PAYABLE_MS } from "./payment-orders"
import type { PaymentProvider } from "./payment/provider"

// 对账（架构 §6.3，spec306）：以通道为镜子核对本地账。**只读不改账**，差异落表交人工/退款流程处置。
// 仅有的两个写动作都有明确授权：① unknown 满 24h 且通道明确失败 → 订单收敛 failed
//    （24h 延迟给迟到的真实 PAID 回调留门——收敛过早会把钱关在门外，notify 侧对终态单收到 PAID 有告警兜底）；
// ② 超时无了结的孤儿 hold → 自动 release（spec302 C1；了结唯一索引保证与并发 settle 绝不双记）。
// 差异幂等：同 (diffType, subject) 至多一行 open（DB 部分唯一索引兜底，并发跑也不双记；
// 持久问题不逐日重复落，人工 resolve 后再次检出才开新行）。

/** 对账只需要查询能力：Pick 收窄，便于注入 mock（不自建 provider 接口）。 */
export type ReconcileProvider = Pick<PaymentProvider, "query">
export type AlertHook = (msg: string, detail: unknown) => void

const defaultAlert: AlertHook = (msg, detail) => console.error(`[reconcile] ${msg}`, detail)
/** 对账日/差异日期的统一口径：UTC YYYY-MM-DD。 */
export const toBillDate = (d: Date): string => d.toISOString().slice(0, 10)
/** 订单可支付窗（同源 payment-orders）：晚结算订单最多滞后此窗才终态，对账窗必须≥它才不漏晚结算单。 */
const PAYABLE_WINDOW_MS = STALE_PAYABLE_MS
/** unknown 收敛 failed 的最小账龄：给迟到回调留门。 */
const UNKNOWN_CONVERGE_MIN_AGE_MS = DAY_MS

/** 落一条差异：DB 部分唯一索引 (diffType, subject) WHERE open 兜底幂等，插入成功才告警/计数。 */
async function recordDiff(d: typeof reconcileDiffs.$inferInsert, alert: AlertHook): Promise<number> {
  const inserted = await getDb().insert(reconcileDiffs).values(d).onConflictDoNothing().returning({ id: reconcileDiffs.id })
  if (inserted.length === 0) return 0
  alert(`差异: ${d.diffType}`, d)
  return 1
}

/** 通道查询异常分类：网关业务层拒绝（如查无此单）↔ 网络抖动（跳过待下轮）。
 *  口径依据 ShouqianbaProvider 的抛错前缀；Task4 真实冒烟按线上错误码校准（review-followups C11）。 */
function isBizQueryRejection(err: unknown): boolean {
  return err instanceof Error && err.message.includes("收钱吧查询失败")
}

/** 逐单核对：本地终态 vs 通道终态。返回本单新落差异数。 */
async function reconcileOrder(
  order: typeof paymentOrders.$inferSelect,
  date: string,
  provider: ReconcileProvider,
  alert: AlertHook,
): Promise<number> {
  const tradeNo = order.providerTradeNo ?? order.clientSn
  let r
  try {
    r = await provider.query(order.clientSn)
  } catch (err) {
    if (isBizQueryRejection(err) && ["paid", "refunded"].includes(order.status)) {
      // 本地已结算而通道查无此单：单边账（最可疑的一类）
      return recordDiff({ billDate: date, diffType: "provider_missing", subject: tradeNo, tradeNo, orderId: order.id, localValue: order.status }, alert)
    }
    console.error(`[reconcile] 查询失败（网络类，下轮重试）order=${order.id}`, err)
    return 0
  }

  if (order.status === "unknown") {
    if (r.status === "paid") {
      // 钱已收、账没入——最高优先级差异；补入账由 spec310 人工确认后走 markPaid({allowStale}) 幂等驱动
      return recordDiff(
        { billDate: date, diffType: "unknown_paid", subject: r.sn ?? order.clientSn, tradeNo: r.sn ?? order.clientSn, orderId: order.id, localValue: "unknown", billValue: String(r.totalAmountCents ?? "") },
        alert,
      )
    }
    if (r.status === "failed" && Date.now() - order.createdAt.getTime() >= UNKNOWN_CONVERGE_MIN_AGE_MS) {
      // 对账唯一允许的订单写动作：满 24h 且通道明确失败 → 收敛 failed（条件 UPDATE 幂等）
      await getDb()
        .update(paymentOrders)
        .set({ status: "failed" })
        .where(and(eq(paymentOrders.id, order.id), eq(paymentOrders.status, "unknown")))
    }
    return 0
  }

  let diffs = 0
  // 本地 paid：通道必须也是 paid；本地 refunded：通道必须已退款（退款没到通道=资损单边账）
  const statusOk = order.status === "paid" ? r.status === "paid" : order.status === "refunded" ? r.status === "refunded" : true
  if (!statusOk) {
    diffs += await recordDiff(
      { billDate: date, diffType: "status_mismatch", subject: tradeNo, tradeNo, orderId: order.id, localValue: order.status, billValue: r.status },
      alert,
    )
  }
  if (order.status === "paid" && r.totalAmountCents != null && r.totalAmountCents !== order.amountCents) {
    diffs += await recordDiff(
      { billDate: date, diffType: "amount_mismatch", subject: tradeNo, tradeNo, orderId: order.id, localValue: String(order.amountCents), billValue: String(r.totalAmountCents) },
      alert,
    )
  }
  return diffs
}

/**
 * 每日对账（job 体，可直调测试）：扫 [date-7天, date+1天) 建单的已结算（paid/refunded）订单
 * + **全部存量 unknown**（不限窗口——unknown 必须清算到终态为止），逐笔问通道核对金额/状态。
 * 窗口拓宽到可支付窗（7 天）：D 日建单可能 D+n 日才被迟到回调结算，只扫当日会漏掉这批最需要核对的单。
 * 幂等可重复跑（差异落表 DB 唯一索引去重）；单笔查询失败不阻塞其余。
 */
export async function runReconcile(
  date: string, // YYYY-MM-DD
  deps: { provider: ReconcileProvider; alertHook?: AlertHook },
): Promise<{ checked: number; diffs: number }> {
  const alert = deps.alertHook ?? defaultAlert
  const dayEnd = new Date(new Date(`${date}T00:00:00.000Z`).getTime() + DAY_MS)
  if (Number.isNaN(dayEnd.getTime())) throw new Error(`非法对账日：${date}`)
  const windowStart = new Date(dayEnd.getTime() - DAY_MS - PAYABLE_WINDOW_MS)
  const settled = await getDb()
    .select()
    .from(paymentOrders)
    .where(and(gte(paymentOrders.createdAt, windowStart), lt(paymentOrders.createdAt, dayEnd), inArray(paymentOrders.status, ["paid", "refunded"])))
  const unknowns = await getDb().select().from(paymentOrders).where(eq(paymentOrders.status, "unknown"))
  const targets = [...settled, ...unknowns] // 两集合按状态天然不相交（paid/refunded vs unknown）

  let diffs = 0
  for (const o of targets) {
    diffs += await reconcileOrder(o, date, deps.provider, alert)
  }
  return { checked: targets.length, diffs }
}

/** 积分账本独立审计：缓存余额 vs Σ流水，双向核对（含「有缓存无流水」的孤儿缓存行）。
 *  候选不一致先**单用户复查**再落 diff——两次全表查询非同一快照，在途交易会造成一闪而过的假差异。 */
export async function auditLedger(
  date: string = toBillDate(new Date()),
  alertHook: AlertHook = defaultAlert,
): Promise<Array<{ userId: string; cached: number; actual: number }>> {
  const sums = await getDb()
    .select({ userId: creditTransactions.userId, actual: sql<number>`coalesce(sum(${creditTransactions.amount}), 0)` })
    .from(creditTransactions)
    .groupBy(creditTransactions.userId)
  const balances = await getDb().select().from(creditBalances)
  const actualMap = new Map(sums.map((s) => [s.userId, Number(s.actual)]))
  const cacheMap = new Map(balances.map((b) => [b.userId, b.balance]))

  const bad: Array<{ userId: string; cached: number; actual: number }> = []
  const userIds = new Set([...actualMap.keys(), ...cacheMap.keys()]) // 双向：漏任一侧都要抓
  for (const userId of userIds) {
    if ((actualMap.get(userId) ?? 0) === (cacheMap.get(userId) ?? 0)) continue
    // 复查（单用户两条小查询，间隔内在途交易已提交）：仍不一致才是真差异
    const [sum] = await getDb()
      .select({ actual: sql<number>`coalesce(sum(${creditTransactions.amount}), 0)` })
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, userId))
    const [cache] = await getDb().select().from(creditBalances).where(eq(creditBalances.userId, userId))
    const actual = Number(sum?.actual ?? 0)
    const cached = cache?.balance ?? 0
    if (cached === actual) continue
    bad.push({ userId, cached, actual })
    await recordDiff(
      { billDate: date, diffType: "ledger_mismatch", subject: userId, userId, localValue: String(cached), billValue: String(actual) },
      alertHook,
    )
  }
  return bad
}

/** 孤儿 hold 清扫（spec302 C1）：进程被杀在 hold 与了结之间 → 积分被冻结无人回收。
 *  扫超过 cutoff（默认 24h，任何编排任务都远早于此收尾）仍无 settle/release 的 hold → 自动 release 退还
 *  + 落 orphan_hold 差异留痕（subject=holdId，同日多个孤儿各留一行）。
 *  只有 release **真的插入了退还行**才计数/留痕——与迟到 settle 竞争输了（唯一索引吞掉）或 hold 已随用户
 *  级联删除时不得虚记；逐条隔离，单条失败不阻塞其余。 */
export async function releaseOrphanHolds(
  now: Date = new Date(),
  opts: { maxAgeMs?: number; alertHook?: AlertHook } = {},
): Promise<number> {
  const alert = opts.alertHook ?? defaultAlert
  const cutoff = new Date(now.getTime() - (opts.maxAgeMs ?? DAY_MS))
  const orphans = await getDb()
    .select()
    .from(creditTransactions)
    .where(
      and(
        eq(creditTransactions.type, "hold"),
        lte(creditTransactions.createdAt, cutoff),
        sql`not exists (select 1 from ${creditTransactions} s where s.ref = ${creditTransactions.id}::text and s.type in ('settle','release'))`,
      ),
    )
  let released = 0
  for (const h of orphans) {
    try {
      const didRelease = await credits.release(h.id, { idempotencyKey: `orphan_release:${h.id}` })
      if (!didRelease) continue // 迟到 settle 赢了/幂等命中/行已删：没有真实退还，不留痕
      await recordDiff(
        { billDate: toBillDate(now), diffType: "orphan_hold", subject: h.id, userId: h.userId, localValue: h.id, billValue: String(-h.amount) },
        alert,
      )
      released++
    } catch (err) {
      console.error(`[reconcile] 孤儿 hold 清扫失败（下轮重试）hold=${h.id}`, err)
    }
  }
  return released
}

/** 卡死退款扫描：pending 超过 maxAge（默认 1h）的两种成因——① createRefund 通道调用抛错（结果不明，
 *  主动留 pending 交本扫描）；② 进程在「建单→通道调用→落账」中间崩溃。两者通道侧都可能已实际退款，
 *  **不自动重试**（换 refundSn 重试是通道侧双退的经典路径），落 refund_stuck 差异转人工核对通道后处置。 */
export async function scanStuckRefunds(
  now: Date = new Date(),
  opts: { maxAgeMs?: number; alertHook?: AlertHook } = {},
): Promise<number> {
  const alert = opts.alertHook ?? defaultAlert
  const cutoff = new Date(now.getTime() - (opts.maxAgeMs ?? 3600_000))
  const stuck = await getDb()
    .select()
    .from(refunds)
    .where(and(eq(refunds.status, "pending"), lte(refunds.createdAt, cutoff)))
  let found = 0
  for (const r of stuck) {
    found += await recordDiff(
      {
        billDate: toBillDate(now),
        diffType: "refund_stuck",
        subject: r.id,
        orderId: r.orderId,
        localValue: r.id,
        billValue: String(r.amountCents),
      },
      alert,
    )
  }
  return found
}
