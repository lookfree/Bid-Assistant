import { and, eq, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm"
import { getDb } from "../db/client"
import { paymentOrders, reconcileDiffs, creditTransactions, creditBalances } from "../db/schema"
import * as credits from "./credits"
import type { PaymentProvider } from "./payment/provider"

// 对账（架构 §6.3，spec306）：以通道为镜子核对本地账。**只读不改账**，差异落表交人工/退款流程处置。
// 仅有的两个写动作都有明确授权：① unknown 且通道明确失败 → 订单收敛 failed（计划钦定的唯一订单写）；
// ② 超时无了结的孤儿 hold → 自动 release（spec302 C1；了结唯一索引保证与并发 settle 绝不双记）。

/** 对账只需要查询能力：Pick 收窄，便于注入 mock（不自建 provider 接口）。 */
export type ReconcileProvider = Pick<PaymentProvider, "query">
export type AlertHook = (msg: string, detail: unknown) => void

const defaultAlert: AlertHook = (msg, detail) => console.error(`[reconcile] ${msg}`, detail)
const DAY_MS = 86_400_000

/** 落一条差异（幂等：同 billDate + diffType + 同主体(tradeNo/userId) 已有 open 则跳过，可重复跑）。 */
async function recordDiff(d: typeof reconcileDiffs.$inferInsert, alert: AlertHook): Promise<boolean> {
  const subjectCond = d.tradeNo
    ? eq(reconcileDiffs.tradeNo, d.tradeNo)
    : d.userId
      ? eq(reconcileDiffs.userId, d.userId)
      : isNull(reconcileDiffs.tradeNo)
  const existing = await getDb()
    .select({ id: reconcileDiffs.id })
    .from(reconcileDiffs)
    .where(and(eq(reconcileDiffs.billDate, d.billDate), eq(reconcileDiffs.diffType, d.diffType), subjectCond, eq(reconcileDiffs.resolved, "open")))
  if (existing.length > 0) return false
  await getDb().insert(reconcileDiffs).values(d)
  alert(`差异: ${d.diffType}`, d)
  return true
}

/** 通道查询异常分类：网关业务层拒绝（如查无此单）↔ 网络抖动（跳过待下轮）。
 *  口径依据 ShouqianbaProvider 的抛错前缀；Task4 真实冒烟按线上错误码校准（review-followups C11）。 */
function isBizQueryRejection(err: unknown): boolean {
  return err instanceof Error && err.message.includes("收钱吧查询失败")
}

/** 逐单核对：本地终态 vs 通道终态。返回本单新落差异数。 */
async function reconcileOrder(order: typeof paymentOrders.$inferSelect, date: string, provider: ReconcileProvider, alert: AlertHook): Promise<number> {
  let r
  try {
    r = await provider.query(order.clientSn)
  } catch (err) {
    if (isBizQueryRejection(err) && ["paid", "refunded"].includes(order.status)) {
      // 本地已结算而通道查无此单：单边账（最可疑的一类）
      return (await recordDiff(
        { billDate: date, diffType: "provider_missing", tradeNo: order.providerTradeNo ?? order.clientSn, orderId: order.id, localValue: order.status },
        alert,
      ))
        ? 1
        : 0
    }
    console.error(`[reconcile] 查询失败（网络类，下轮重试）order=${order.id}`, err)
    return 0
  }

  let diffs = 0
  if (order.status === "unknown") {
    if (r.status === "paid") {
      // 钱已收、账没入——最高优先级差异；补入账走幂等 markPaid（人工确认后触发/spec310）
      if (
        await recordDiff(
          { billDate: date, diffType: "unknown_paid", tradeNo: r.sn ?? order.clientSn, orderId: order.id, localValue: "unknown", billValue: String(r.totalAmountCents ?? "") },
          alert,
        )
      )
        diffs++
    } else if (r.status === "failed") {
      // 对账唯一允许的订单写动作：通道明确失败 → unknown 收敛 failed（条件 UPDATE 幂等）
      await getDb()
        .update(paymentOrders)
        .set({ status: "failed" })
        .where(and(eq(paymentOrders.id, order.id), eq(paymentOrders.status, "unknown")))
    }
    return diffs
  }

  // 本地 paid/refunded
  if (order.status === "paid" && r.status !== "paid") {
    if (
      await recordDiff(
        { billDate: date, diffType: "status_mismatch", tradeNo: order.providerTradeNo ?? order.clientSn, orderId: order.id, localValue: order.status, billValue: r.status },
        alert,
      )
    )
      diffs++
  }
  if (r.totalAmountCents != null && r.totalAmountCents !== order.amountCents) {
    if (
      await recordDiff(
        { billDate: date, diffType: "amount_mismatch", tradeNo: order.providerTradeNo ?? order.clientSn, orderId: order.id, localValue: String(order.amountCents), billValue: String(r.totalAmountCents) },
        alert,
      )
    )
      diffs++
  }
  return diffs
}

/**
 * 每日对账（job 体，可直调测试）：扫当日窗口 [date 00:00Z, 次日 00:00Z) 的已结算订单
 * + **全部存量 unknown**（不限当日——unknown 必须清算到终态为止），逐笔问通道核对金额/状态。
 * 幂等可重复跑（差异落表有去重）；单笔查询失败不阻塞其余。
 */
export async function runReconcile(
  date: string, // YYYY-MM-DD
  deps: { provider: ReconcileProvider; alertHook?: AlertHook },
): Promise<{ checked: number; diffs: number }> {
  const alert = deps.alertHook ?? defaultAlert
  const dayStart = new Date(`${date}T00:00:00.000Z`)
  const dayEnd = new Date(dayStart.getTime() + DAY_MS)
  const dayOrders = await getDb()
    .select()
    .from(paymentOrders)
    .where(and(gte(paymentOrders.createdAt, dayStart), lt(paymentOrders.createdAt, dayEnd), inArray(paymentOrders.status, ["paid", "refunded"])))
  const unknowns = await getDb().select().from(paymentOrders).where(eq(paymentOrders.status, "unknown"))
  const seen = new Set<string>()
  const targets = [...dayOrders, ...unknowns].filter((o) => (seen.has(o.id) ? false : (seen.add(o.id), true)))

  let diffs = 0
  for (const o of targets) {
    diffs += await reconcileOrder(o, date, deps.provider, alert)
  }
  return { checked: targets.length, diffs }
}

/** 积分账本独立审计：缓存余额 vs Σ流水，双向核对（含「有缓存无流水」的孤儿缓存行）。
 *  不一致落 ledger_mismatch（幂等）+ 告警；返回不一致清单（调用方可过滤/断言）。 */
export async function auditLedger(
  date: string = new Date().toISOString().slice(0, 10),
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
    const actual = actualMap.get(userId) ?? 0
    const cached = cacheMap.get(userId) ?? 0
    if (cached === actual) continue
    bad.push({ userId, cached, actual })
    await recordDiff(
      { billDate: date, diffType: "ledger_mismatch", userId, localValue: String(cached), billValue: String(actual) },
      alertHook,
    )
  }
  return bad
}

/** 孤儿 hold 清扫（spec302 C1）：进程被杀在 hold 与了结之间 → 积分被冻结无人回收。
 *  扫超过 cutoff（默认 24h，任何编排任务都远早于此收尾）仍无 settle/release 的 hold → 自动 release 退还
 *  + 落 orphan_hold 差异留痕。安全性由了结唯一索引兜底：与迟到的 settle 并发也绝不双记。 */
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
    await credits.release(h.id, { idempotencyKey: `orphan_release:${h.id}` })
    await recordDiff(
      {
        billDate: now.toISOString().slice(0, 10),
        diffType: "orphan_hold",
        userId: h.userId,
        localValue: h.id,
        billValue: String(-h.amount), // 被冻结的额度
      },
      alert,
    )
    released++
  }
  return released
}
