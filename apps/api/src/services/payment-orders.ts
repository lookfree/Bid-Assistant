import { randomUUID } from "node:crypto"
import { and, eq, inArray, lte } from "drizzle-orm"
import { getDb } from "../db/client"
import { paymentOrders } from "../db/schema"
import { getConfig } from "./config"
import * as credits from "./credits"
import { renewOnPaid } from "./renewal"
import type { CronJob } from "./cron"
import type { PaymentProvider } from "./payment/provider"

// 支付订单服务（架构 §6.1，资金正确性铁律见 spec300-index）：
// - 服务端定价：金额/到账积分在下单时快照进订单，回调只用于触发、不信其金额之外的任何口径；
// - 状态机唯一赢家：→paid 用条件 UPDATE 原子推进，回调与轮询并发只有一个入账；
//   可入账的起点是 created 和 unknown（unknown 非终态——窗口尽头置 unknown 后迟到的 PAID 回调仍要入账）；
// - 金额一致性铁律：实付金额缺失或与快照不符都不入账，订单置 unknown 进对账队列（spec306 扫 unknown）；
// - 置 paid 与 grant 在同一事务：grant 失败整体回滚，回调重试/轮询/扫单都能重新驱动（不吞钱）。

export type OrderType = "recharge" | "purchase" | "renewal"

/** 下单（幂等：同 idempotencyKey 返回同一单）。金额/积分由调用方从服务端配置取好快照后传入。 */
export async function createOrder(input: {
  userId: string
  type: OrderType
  amountCents: number
  creditsSnapshot?: number
  planId?: string // renewal/purchase 单：续/购的套餐
  idempotencyKey: string
}): Promise<{ id: string; clientSn: string }> {
  const inserted = await getDb()
    .insert(paymentOrders)
    .values({
      userId: input.userId,
      type: input.type,
      amountCents: input.amountCents,
      creditsSnapshot: input.creditsSnapshot,
      planId: input.planId,
      clientSn: `bid-${randomUUID()}`, // 我方订单号，送收钱吧，全局唯一
      idempotencyKey: input.idempotencyKey,
    })
    .onConflictDoNothing({ target: paymentOrders.idempotencyKey })
    .returning()
  if (inserted[0]) return { id: inserted[0].id, clientSn: inserted[0].clientSn }
  const [exist] = await getDb().select().from(paymentOrders).where(eq(paymentOrders.idempotencyKey, input.idempotencyKey))
  if (!exist) throw new Error("下单幂等冲突但查不到原单")
  return { id: exist.id, clientSn: exist.clientSn }
}

export type MarkPaidResult = {
  paid: boolean
  reason?: "not_found" | "amount_missing" | "amount_mismatch" | "already_final"
}

/** paid 状态机可推进的起点：created（正常）、unknown（窗口尽头/金额异常后迟到的有效支付）。 */
const PAYABLE_STATUSES = ["created", "unknown"]

/**
 * 置 paid + 入账（同一事务、只一次）：
 * 1) 金额铁律：实付金额缺失（通道没给）或与快照不符 → 不入账，订单 created→unknown 进对账队列并告警；
 * 2) 条件 UPDATE `status IN (created,unknown) → paid` 原子推进，返回行数判定唯一赢家；
 * 3) 赢家在同事务内 grant 快照积分（幂等键 purchase:<orderId>）：grant 失败连状态一起回滚，
 *    通道重试/轮询/扫单可重新驱动——杜绝「订单 paid 但积分永远没发」的不可见资损。
 * 充值积分不设有效期（无 purchase_expire_days 口径，决策见 review-followups spec304）。
 * 会员激活（purchase/renewal 的订阅生效）留 TODO：spec308 会员中心接管。
 * deps.grantFn 仅测试注入（验证事务回滚），生产走 credits.grant。
 */
export async function markPaid(
  orderId: string,
  info: { sn?: string; tradeNo?: string; payway?: string; paidAmountCents?: number },
  deps: { grantFn?: typeof credits.grant } = {},
): Promise<MarkPaidResult> {
  const [order] = await getDb().select().from(paymentOrders).where(eq(paymentOrders.id, orderId))
  if (!order) return { paid: false, reason: "not_found" }

  if (info.paidAmountCents == null || info.paidAmountCents !== order.amountCents) {
    const reason = info.paidAmountCents == null ? "amount_missing" : "amount_mismatch"
    console.error(
      `[payment] 金额校验不过(${reason}) order=${orderId} 快照=${order.amountCents} 实付=${info.paidAmountCents ?? "缺失"}，不入账、置 unknown 待对账`,
    )
    await markFinal(orderId, "unknown") // 进对账队列（spec306 扫 unknown）；created 之外的状态不动
    return { paid: false, reason }
  }

  const grantFn = deps.grantFn ?? credits.grant
  return await getDb().transaction(async (tx) => {
    const winner = await tx
      .update(paymentOrders)
      .set({ status: "paid", providerTradeNo: info.sn, channelTradeNo: info.tradeNo, payway: info.payway })
      .where(and(eq(paymentOrders.id, orderId), inArray(paymentOrders.status, PAYABLE_STATUSES))) // 唯一赢家
      .returning()
    if (winner.length === 0) return { paid: false, reason: "already_final" as const }

    if (order.creditsSnapshot != null && order.creditsSnapshot > 0) {
      await grantFn(
        order.userId,
        order.creditsSnapshot,
        { type: "purchase", sourceBatch: orderId, ref: orderId, idempotencyKey: `purchase:${orderId}` },
        tx, // 状态与入账同事务提交；幂等键是并发双保险
      )
    }
    if (order.type === "renewal") {
      // 续期 + 发当期积分与置 paid 同事务（spec305）：失败整体回滚，通道重试重新驱动
      await renewOnPaid({ orderId: order.id, userId: order.userId, planId: order.planId }, tx, deps)
    }
    // TODO(spec308): purchase 单（首购会员）在此激活订阅
    return { paid: true }
  })
}

/** 非 paid 去向（failed=通道明确取消/过期；unknown=窗口尽头或金额异常，待对账）：仅从 created 推进。 */
export async function markFinal(orderId: string, status: "failed" | "unknown"): Promise<void> {
  await getDb()
    .update(paymentOrders)
    .set({ status })
    .where(and(eq(paymentOrders.id, orderId), eq(paymentOrders.status, "created")))
}

type PollConfig = { windowMinutes: number; fastSeconds: number; slowSeconds: number }
const POLL_DEFAULTS: PollConfig = { windowMinutes: 6, fastSeconds: 3, slowSeconds: 10 } // 收钱吧官方节奏

/** 轮询配置消毒：非正数/非有限值一律回落官方默认——fastSeconds=0 会变成打爆网关的死循环。 */
async function pollConfig(): Promise<PollConfig> {
  const raw = await getConfig<Partial<PollConfig>>("payment_poll")
  const pick = (v: number | undefined, dflt: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : dflt)
  return {
    windowMinutes: pick(raw?.windowMinutes, POLL_DEFAULTS.windowMinutes),
    fastSeconds: pick(raw?.fastSeconds, POLL_DEFAULTS.fastSeconds),
    slowSeconds: pick(raw?.slowSeconds, POLL_DEFAULTS.slowSeconds),
  }
}

/** 单次查询结果落到订单上，返回订单去向；无终态返回 undefined（继续轮询）。 */
async function settleQueryResult(
  orderId: string,
  r: Awaited<ReturnType<PaymentProvider["query"]>>,
): Promise<"paid" | "failed" | "unknown" | undefined> {
  if (r.status === "paid") {
    const res = await markPaid(orderId, { sn: r.sn, tradeNo: r.tradeNo, payway: r.payway, paidAmountCents: r.totalAmountCents })
    if (res.paid || res.reason === "already_final") return "paid" // already_final：另一通道已处理
    return "unknown" // 金额缺失/不符：markPaid 已置 unknown 进对账
  }
  if (r.status === "failed") {
    await markFinal(orderId, "failed")
    return "failed"
  }
  return undefined
}

/**
 * 收钱吧官方轮询节奏：0-1min 每 fast(3s)、1-5min 每 slow(10s)、第 windowMinutes(6) 分钟最后一次。
 * sleepFn 可注入（测试免等待）；query 异常按 pending 继续（网关抖动不终止轮询）。
 * 进程内轮询会被重启孤儿化——paymentOrderSweepJob 是兜底通道（扫超窗 created 单）。
 */
export async function pollUntilFinal(
  orderId: string,
  opts: { provider: PaymentProvider; sleepFn?: (ms: number) => Promise<void> },
): Promise<"paid" | "failed" | "unknown"> {
  const sleepFn = opts.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const cfg = await pollConfig()
  const [order] = await getDb().select().from(paymentOrders).where(eq(paymentOrders.id, orderId))
  if (!order) return "unknown"

  const windowSec = cfg.windowMinutes * 60
  const slowUntil = 5 * 60 // 官方：1-5 分钟慢轮询，之后直接跳到窗口尾最后一查
  let elapsed = 0
  while (elapsed < windowSec) {
    const delay = elapsed < 60 ? cfg.fastSeconds : elapsed < slowUntil ? cfg.slowSeconds : windowSec - elapsed
    await sleepFn(delay * 1000)
    elapsed += delay
    try {
      const outcome = await settleQueryResult(orderId, await opts.provider.query(order.clientSn))
      if (outcome) return outcome
    } catch (err) {
      console.error(`[payment] 轮询查询失败 order=${orderId}（继续下一次）`, err)
    }
  }
  await markFinal(orderId, "unknown") // 窗口用尽无终态（钱可能已付，spec306 对账清算）
  return "unknown"
}

/**
 * 滞留单扫描（Cron job 体）：进程重启会孤儿化 pollUntilFinal，且 spec306 对账不扫 created——
 * 没有这层，用户付了钱而订单永远停在 created，任何安全网都看不见。
 * 扫超过轮询窗口仍 created 的单：逐单问通道终态 → paid 入账 / failed 关单 / 其余置 unknown 待对账。
 * 幂等：markPaid 状态机 + grant 幂等键；单笔失败不阻塞其他单。返回本轮处理单数。
 */
export async function sweepStaleCreatedOrders(provider: PaymentProvider, now: Date = new Date()): Promise<number> {
  const cfg = await pollConfig()
  const cutoff = new Date(now.getTime() - (cfg.windowMinutes + 1) * 60_000) // 窗口 + 1min 缓冲，不与在途轮询抢单
  const stale = await getDb()
    .select()
    .from(paymentOrders)
    .where(and(eq(paymentOrders.status, "created"), lte(paymentOrders.createdAt, cutoff)))
  let handled = 0
  for (const o of stale) {
    try {
      const outcome = await settleQueryResult(o.id, await provider.query(o.clientSn))
      if (!outcome) await markFinal(o.id, "unknown") // 超窗仍 pending → 待对账
      handled++
    } catch (err) {
      console.error(`[payment] 滞留单查询失败 order=${o.id}（下一轮重试）`, err)
    }
  }
  return handled
}

/** 滞留单扫描 CronJob（spec303 startCronRunner 注册，集群单实例执行）。 */
export function paymentOrderSweepJob(provider: PaymentProvider): CronJob {
  return {
    name: "payment-order-sweep",
    everyMs: 60_000,
    jobFn: async () => {
      await sweepStaleCreatedOrders(provider)
    },
  }
}
