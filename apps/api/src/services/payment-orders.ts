import { randomUUID } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { getDb } from "../db/client"
import { paymentOrders } from "../db/schema"
import { getConfig } from "./config"
import * as credits from "./credits"
import type { PaymentProvider } from "./payment/provider"

// 支付订单服务（架构 §6.1，资金正确性铁律见 spec300-index）：
// - 服务端定价：金额/到账积分在下单时快照进订单，回调只用于触发、不信其金额之外的任何口径；
// - 状态机唯一赢家：created→paid 用条件 UPDATE 原子推进，回调与轮询并发只有一个入账；
// - 金额一致性：markPaid 前校验实付==快照，不一致不入账（留 created 给对账，spec306 清算）；
// - 轮询窗口用尽无终态 → unknown（不置 failed——钱可能已付）。

export type OrderType = "recharge" | "purchase" | "renewal"

/** 下单（幂等：同 idempotencyKey 返回同一单）。金额/积分由调用方从服务端配置取好快照后传入。 */
export async function createOrder(input: {
  userId: string
  type: OrderType
  amountCents: number
  creditsSnapshot?: number
  idempotencyKey: string
}): Promise<{ id: string; clientSn: string }> {
  const inserted = await getDb()
    .insert(paymentOrders)
    .values({
      userId: input.userId,
      type: input.type,
      amountCents: input.amountCents,
      creditsSnapshot: input.creditsSnapshot,
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

export type MarkPaidResult = { paid: boolean; reason?: "not_found" | "amount_mismatch" | "already_final" }

/**
 * 置 paid + 入账（只一次）：
 * 1) 金额校验：paidAmountCents 与订单快照不符 → 不动状态、告警返回（订单留给对账）；
 * 2) 条件 UPDATE `status='created'→'paid'` 原子推进，返回行数判定唯一赢家；
 * 3) 赢家对 recharge 单 grant 快照积分（幂等键 purchase:<orderId>，spec302 唯一约束兜底）。
 * 会员激活（purchase/renewal 的订阅生效）留 TODO：spec308 会员中心接管。
 */
export async function markPaid(
  orderId: string,
  info: { sn?: string; tradeNo?: string; payway?: string; paidAmountCents?: number },
): Promise<MarkPaidResult> {
  const [order] = await getDb().select().from(paymentOrders).where(eq(paymentOrders.id, orderId))
  if (!order) return { paid: false, reason: "not_found" }
  if (info.paidAmountCents != null && info.paidAmountCents !== order.amountCents) {
    console.error(`[payment] 金额不符 order=${orderId} 快照=${order.amountCents} 实付=${info.paidAmountCents}，不入账待对账`)
    return { paid: false, reason: "amount_mismatch" }
  }

  const winner = await getDb()
    .update(paymentOrders)
    .set({ status: "paid", providerTradeNo: info.sn, channelTradeNo: info.tradeNo, payway: info.payway })
    .where(and(eq(paymentOrders.id, orderId), eq(paymentOrders.status, "created"))) // 唯一赢家
    .returning()
  if (winner.length === 0) return { paid: false, reason: "already_final" }

  if (order.creditsSnapshot != null && order.creditsSnapshot > 0) {
    await credits.grant(order.userId, order.creditsSnapshot, {
      type: "purchase",
      ref: orderId,
      idempotencyKey: `purchase:${orderId}`, // 双保险：状态机单赢家 + 账本幂等键
    })
  }
  // TODO(spec308): purchase/renewal 单在此激活/续期订阅并发当期赠送积分
  return { paid: true }
}

/** 终态失败（CANCELED/EXPIRED 等）：created→failed，同样条件 UPDATE。 */
async function markFailed(orderId: string): Promise<void> {
  await getDb()
    .update(paymentOrders)
    .set({ status: "failed" })
    .where(and(eq(paymentOrders.id, orderId), eq(paymentOrders.status, "created")))
}

/** 窗口用尽无终态：created→unknown（钱可能已付，spec306 对账清算）。 */
async function markUnknown(orderId: string): Promise<void> {
  await getDb()
    .update(paymentOrders)
    .set({ status: "unknown" })
    .where(and(eq(paymentOrders.id, orderId), eq(paymentOrders.status, "created")))
}

type PollConfig = { windowMinutes: number; fastSeconds: number; slowSeconds: number }

/**
 * 收钱吧官方轮询节奏：0-1min 每 fast(3s)、1-5min 每 slow(10s)、第 windowMinutes(6) 分钟最后一次。
 * sleepFn 可注入（测试免等待）；query 异常按 pending 继续（网关抖动不终止轮询）。
 * 返回本次轮询得到的订单去向：paid / failed / unknown。
 */
export async function pollUntilFinal(
  orderId: string,
  opts: { provider: PaymentProvider; sleepFn?: (ms: number) => Promise<void> },
): Promise<"paid" | "failed" | "unknown"> {
  const sleepFn = opts.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const cfg = (await getConfig<PollConfig>("payment_poll")) ?? { windowMinutes: 6, fastSeconds: 3, slowSeconds: 10 }
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
      const r = await opts.provider.query(order.clientSn)
      if (r.status === "paid") {
        await markPaid(orderId, { sn: r.sn, tradeNo: r.tradeNo, payway: r.payway, paidAmountCents: r.totalAmountCents })
        return "paid"
      }
      if (r.status === "failed") {
        await markFailed(orderId)
        return "failed"
      }
    } catch (err) {
      console.error(`[payment] 轮询查询失败 order=${orderId}（继续下一次）`, err)
    }
  }
  await markUnknown(orderId)
  return "unknown"
}
