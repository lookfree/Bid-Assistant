import { randomUUID } from "node:crypto"
import { and, count, eq, inArray, lte } from "drizzle-orm"
import { getDb } from "../db/client"
import { paymentOrders } from "../db/schema"
import { getConfig, pickPositive } from "./config"
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
  cycleSnapshot?: string // renewal 单：下单时的计费周期快照
  idempotencyKey: string
}): Promise<{ id: string; clientSn: string }> {
  // 类型不变式（钱从严）：renewal 单没套餐无法结算（续什么？）；recharge 单带套餐说明调用方拿错了类型
  if (input.type === "renewal" && !input.planId) throw new Error("renewal 单必须携带 planId")
  if (input.type === "recharge" && input.planId) throw new Error("recharge 单不得携带 planId")
  const inserted = await getDb()
    .insert(paymentOrders)
    .values({
      userId: input.userId,
      type: input.type,
      amountCents: input.amountCents,
      creditsSnapshot: input.creditsSnapshot,
      planId: input.planId,
      cycleSnapshot: input.cycleSnapshot,
      // 我方订单号，送收钱吧，全局唯一；≤32 字符（收钱吧 client_sn 上限，冒烟实测超限即拒单）
      clientSn: `bid${Date.now().toString(36)}${randomUUID().replace(/-/g, "").slice(0, 14)}`,
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
  reason?: "not_found" | "amount_missing" | "amount_mismatch" | "already_final" | "stale_order"
}

/** paid 状态机可推进的起点：created（正常）、unknown（窗口尽头/金额异常后迟到的有效支付）。 */
const PAYABLE_STATUSES = ["created", "unknown"]

/** 订单可支付窗（下单起 7 天）：unknown 非终态是为真实迟到回调留的门，不能顺带变成囤旧价单的套利门。
 *  对账窗（reconcile）与此同源——调窗口只改这一处。 */
export const STALE_PAYABLE_MS = 7 * 24 * 60 * 60 * 1000

/** 用户当前开放（created）订单数：下单频控用——created 单会被扫单 Cron 在窗口后收敛，天然退火。 */
export async function countOpenOrders(userId: string): Promise<number> {
  const [row] = await getDb()
    .select({ n: count() })
    .from(paymentOrders)
    .where(and(eq(paymentOrders.userId, userId), eq(paymentOrders.status, "created")))
  return Number(row?.n ?? 0)
}

/**
 * 置 paid + 入账（同一事务、只一次），入账按 order.type 分发（recharge=充值积分 / renewal=续期+当期积分）：
 * 1) 金额铁律：实付金额缺失（通道没给）或与快照不符 → 不入账，订单 created→unknown 进对账队列并告警；
 * 2) 超期窗：订单创建超 STALE_PAYABLE_MS 后收到 PAID（疑似囤单套利/极端迟到）→ 不入账、告警留人工对账
 *    （通道侧 WAP 单 4 分钟有效是第一道防线，此为纵深；决策见 review-followups spec305）；
 * 3) 条件 UPDATE `status IN (created,unknown) → paid` 原子推进，返回行数判定唯一赢家；
 * 4) 赢家在同事务内入账：grant/续期失败连状态一起回滚，通道重试/轮询/扫单可重新驱动
 *    ——杜绝「订单 paid 但积分/周期永远没落」的不可见资损。
 * 充值积分不设有效期（决策见 review-followups spec304 C7）；续费当期积分随周期作废（spec305）。
 * spec308 首购（purchase）分支在此扩展。
 * deps.grantFn 仅测试注入（验证事务回滚）——注意会替换**所有**入账路径（充值与续费）。
 */
export async function markPaid(
  orderId: string,
  info: { sn?: string; tradeNo?: string; payway?: string; paidAmountCents?: number },
  // allowStale：spec310 对账修复入口专用（unknown_paid 差异人工确认后补入账，可能已超 7 天窗）；
  // 常规通道（回调/轮询/扫单）一律不传——防囤单套利的纵深仍然生效
  deps: { grantFn?: typeof credits.grant; allowStale?: boolean } = {},
): Promise<MarkPaidResult> {
  const [order] = await getDb().select().from(paymentOrders).where(eq(paymentOrders.id, orderId))
  if (!order) return { paid: false, reason: "not_found" }

  if (!deps.allowStale && Date.now() - order.createdAt.getTime() > STALE_PAYABLE_MS) {
    console.error(
      `[payment] 超期订单收到支付信号（疑似囤单/极端迟到）order=${orderId} 创建于 ${order.createdAt.toISOString()}，不入账留人工对账`,
    )
    return { paid: false, reason: "stale_order" }
  }
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

    // 入账按订单类型显式分发（不能按附带字段猜——creditsSnapshot 对 recharge/renewal 语义不同，
    // 若两分支都按字段触发，一张带快照的 renewal 单会被 purchase:/renewal: 两个幂等键各记一次=双发）
    if (order.type === "recharge" && order.creditsSnapshot != null && order.creditsSnapshot > 0) {
      await grantFn(
        order.userId,
        order.creditsSnapshot,
        { type: "purchase", sourceBatch: orderId, ref: orderId, idempotencyKey: `purchase:${orderId}` },
        tx, // 状态与入账同事务提交；幂等键是并发双保险
      )
    } else if (order.type === "renewal") {
      // 续期 + 发当期积分与置 paid 同事务（spec305）：失败整体回滚，通道重试重新驱动
      await renewOnPaid(
        { orderId: order.id, userId: order.userId, planId: order.planId, creditsSnapshot: order.creditsSnapshot, cycleSnapshot: order.cycleSnapshot },
        tx,
        deps,
      )
    }
    // TODO(spec308): purchase 单（首购会员）在此扩展分发
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
  return {
    windowMinutes: pickPositive(raw?.windowMinutes, POLL_DEFAULTS.windowMinutes),
    fastSeconds: pickPositive(raw?.fastSeconds, POLL_DEFAULTS.fastSeconds),
    slowSeconds: pickPositive(raw?.slowSeconds, POLL_DEFAULTS.slowSeconds),
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
    let result
    try {
      result = await provider.query(o.clientSn)
    } catch (err) {
      console.error(`[payment] 滞留单查询失败 order=${o.id}（下一轮重试）`, err)
      continue // 网关抖动：留在 created，下一轮再问
    }
    try {
      const outcome = await settleQueryResult(o.id, result)
      if (!outcome) await markFinal(o.id, "unknown") // 超窗仍 pending → 待对账
      handled++
    } catch (err) {
      // 结算持续失败（如 renewal 单数据事故）不能每分钟空转到永远：升级 unknown 进对账队列
      // （unknown 仍可支付，修复后真实回调/对账可重新驱动）
      console.error(`[payment] 滞留单结算失败，转 unknown 进对账 order=${o.id}`, err)
      await markFinal(o.id, "unknown").catch(() => {})
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
