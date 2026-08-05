import { z } from "zod"
import { and, eq, inArray, sql } from "drizzle-orm"
import { getDb } from "../db/client"
import { paymentOrders, refunds, creditTransactions, subscriptions } from "../db/schema"
import { getBalance } from "./credits"
import type { PaymentProvider } from "./payment/provider"
import { writeAudit } from "./audit"
import type { Tx } from "./credits"
import { orderStatusCn, yuan } from "../lib/order-labels"
import { subCycle } from "./renewal"

// 退款编排（架构 §6.2(D)，spec306）：唯一入口收口到 spec310 POST /admin-api/refunds（过 admin RBAC+审计），
// 本模块只产出 service，不建路由——避免出现绕过 RBAC/审计的并行退款入口。
// 铁律：
// - 只退 paid 单；累计退款额（pending+done）≤ 订单额（并发双退在护栏处挡住）；
// - 会员单只允许全额退，退成功时同事务回退一个订阅周期 + 收回该周期积分（否则「钱退了、会员还在」）；
//   部分退款仍拒绝——半个周期无法回退（原 C9 决策是整类转人工，2026-08-05 按运营需要放开全额退）；
// - 通道调用**抛错 ≠ 失败**：网络超时时通道可能已实际退款，标 failed 会让重试换新 refundSn 双退真钱
//   ——歧义结果留 pending（占用累计额度挡住重试），由 scanStuckRefunds 落差异转人工核对；
// - 扣回积分写负向 refund_clawback 流水（不借 release——那是 hold 退还净 0 语义），幂等键 refund_clawback:<refundId>；
//   多次部分退款按**累计比例**计算（每笔=round(总入账×累计退款比例)−已扣回），取整误差不随笔数放大；
// - 扣回超过当前余额（用户已花掉）默认拒绝，操作员确认后带 allowNegativeBalance 强制（余额转负，审计可见）。

/** 收钱吧 refund_request_no 硬性上限 31 字符——refunds.id 是标准 UUID（36 字符，含连字符），
 *  直传必被通道拒绝：生产实测每一笔退款都以 "refund_request_no退款序列号必填，不可超过31字符" 失败，
 *  此前误当成"通道拒绝"，实际是我们自己传参超长，通道压根没进到业务判定。
 *  与 payment-orders.ts 生成 clientSn 同一手法：短前缀 + 自身 UUID 十六进制截断（"rf" + 29 位 = 31），
 *  纯函数、只吃 refundId，同一退款单每次重算得到同一个值，通道侧幂等键因此稳定可重放。 */
export function refundRequestNo(refundId: string): string {
  return `rf${refundId.replace(/-/g, "").slice(0, 29)}`
}

/** 退款只需要 refund 能力：Pick 收窄，便于注入 mock。 */
export type RefundProvider = Pick<PaymentProvider, "refund">

// 退款结果落 admin_audit_logs（评审实测缺陷：此前只 console.info，审计里只有「发起退款」这一条，
// 查纠纷时看不到到底成功、失败、还是落在需人工核对的 pending 态）。best-effort：审计写失败绝不
// 影响已经完成的退款事务本身，只记日志（与其它埋点同范式）。
function auditLog(entry: { operator: string; action: string; orderId: string; before: unknown; after: unknown }) {
  console.info("[audit]", JSON.stringify(entry))
  void writeAudit({
    operator: entry.operator,
    action: entry.action,
    target: `order:${entry.orderId}`,
    before: entry.before,
    after: entry.after,
  }).catch((e) => console.warn("[audit] 退款结果审计写入失败（不影响退款本身）:", e))
}

const InputSchema = z.object({
  orderId: z.string().uuid(),
  amountCents: z.number().int().positive(),
  reason: z.string(),
  operator: z.string().min(1),
  allowNegativeBalance: z.boolean().optional(), // 扣回>余额时需操作员显式确认
  idempotencyKey: z.string().min(1).optional(), // 同意图重试去重（防部分退款重复退真钱）
})
export type RefundInput = z.infer<typeof InputSchema>

type Order = typeof paymentOrders.$inferSelect
type DbOrTx = Tx | ReturnType<typeof getDb>

/** 该订单已入账的正向积分总额（充值到账等，ref=order.id）。 */
async function sumGrantedCredits(db: DbOrTx, orderId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${creditTransactions.amount}), 0)` })
    .from(creditTransactions)
    .where(and(eq(creditTransactions.ref, orderId), sql`${creditTransactions.amount} > 0`))
  return Number(row?.total ?? 0)
}

/** 扣回目标（累计口径）：round(总入账 × 累计退款比例)。公式只此一处，预检与落账口径一致。 */
const clawbackTarget = (granted: number, refundedCents: number, orderAmountCents: number): number =>
  Math.round((granted * refundedCents) / orderAmountCents)

/** ① 事务：行锁下校验（paid/会员单须全额/累计额）+ 建 pending。校验不过抛错，不触发通道调用。 */
async function validateAndCreatePending(
  input: RefundInput,
): Promise<{ order: Order; refundId: string; doneBefore: number; replayedStatus?: "pending" | "done" | "failed" }> {
  return await getDb().transaction(async (tx) => {
    const [order] = await tx.select().from(paymentOrders).where(eq(paymentOrders.id, input.orderId)).for("update")
    if (!order) throw new Error("订单不存在")
    // 幂等重放：同 key 已有退款单 → 直接返回既有结果，不再新建/重扣（须在状态检查前，重放无视当前订单状态）
    if (input.idempotencyKey) {
      const [dup] = await tx.select().from(refunds).where(eq(refunds.idempotencyKey, input.idempotencyKey))
      if (dup) return { order, refundId: dup.id, doneBefore: 0, replayedStatus: dup.status as "pending" | "done" | "failed" }
    }
    if (order.status !== "paid") throw new Error(`该订单当前是「${orderStatusCn(order.status)}」，只有已支付的订单可以退款`)
    // 会员单只放开**全额退**：退成功时同事务回退一个订阅周期 + 按比例收回该周期积分
    // （见 settleRefundDone → rollbackSubscriptionCycle），不会出现「钱退了、会员还在」。
    // 部分退款仍然拦住——半个周期没法回退，按比例缩短会员有效期不是任何一方认可的口径。
    if (order.type === "renewal" && input.amountCents !== order.amountCents) {
      throw new Error(
        `会员订单只支持全额退款（该订单 ${yuan(order.amountCents)}）：退款会同时收回这一个会员周期，` +
        "半个周期无法回退。若需按比例退，请先在收钱吧后台处理，再联系技术同事调整会员有效期。",
      )
    }
    const rows = await tx
      .select({ amountCents: refunds.amountCents, status: refunds.status })
      .from(refunds)
      .where(and(eq(refunds.orderId, order.id), inArray(refunds.status, ["pending", "done"]))) // pending 计入：挡并发双退与歧义未决
    const already = rows.reduce((s, r) => s + r.amountCents, 0)
    if (input.amountCents + already > order.amountCents) {
      throw new Error(
        `退款金额超出订单金额：该订单 ${yuan(order.amountCents)}，已退或在途 ${yuan(already)}，` +
        `本次又要退 ${yuan(input.amountCents)}，合计超出。`,
      )
    }
    const [r] = await tx
      .insert(refunds)
      .values({ orderId: order.id, amountCents: input.amountCents, reason: input.reason, status: "pending", operator: input.operator, idempotencyKey: input.idempotencyKey ?? null })
      .returning()
    const doneBefore = rows.filter((x) => x.status === "done").reduce((s, x) => s + x.amountCents, 0)
    return { order, refundId: r!.id, doneBefore, replayedStatus: undefined as "pending" | "done" | "failed" | undefined }
  })
}

/** 会员单退满后回退订阅周期：把 current_period_end 往回推一个周期，抵消这一单的顺延。
 *
 *  为什么减一个周期就够：每单只顺延一个周期（renewal.ts 的 addCycle），周期是叠加的，
 *  所以无论退的是第几单，减一个周期后的到期时间都对。
 *  回退后若已到期，订阅置 expired（entitlements 按 status + period_end 判权益，两者都要对）。
 *  period_start 只在被新的 end 反超时才跟着回退，避免出现「开始晚于结束」的展示。
 *
 *  一个已知的不覆盖场景：若该单同时把套餐换成了更高档（planId 变更），这里只回退时间、
 *  不回退档位——旧 planId 没有留存快照，无从恢复。目前不存在降级/升级换档的入口，先记在这里。 */
async function rollbackSubscriptionCycle(tx: Tx, order: Order): Promise<void> {
  const cycle = order.cycleSnapshot
  if (!cycle) {
    // 缺周期快照就不敢猜着改会员有效期（宁可整笔退款失败，也不能把会员改错）
    throw new Error("该会员订单缺少计费周期快照，无法自动回退会员有效期，请联系技术处理")
  }
  const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.userId, order.userId)).for("update")
  if (!sub?.currentPeriodEnd) return // 无订阅行/无周期：没有可回退的顺延
  const newEnd = subCycle(sub.currentPeriodEnd, cycle)
  const start = sub.currentPeriodStart && sub.currentPeriodStart > newEnd ? newEnd : sub.currentPeriodStart
  await tx
    .update(subscriptions)
    .set({
      currentPeriodEnd: newEnd,
      currentPeriodStart: start,
      status: newEnd.getTime() <= Date.now() ? "expired" : sub.status,
    })
    .where(eq(subscriptions.id, sub.id))
}

/** ③ 成功落账（事务）：退款单 done + 累计退满才翻订单 refunded（部分退款订单留 paid，剩余额度可继续退）
 *  + 会员单回退订阅周期 + 按累计比例扣回积分。返回是否插入了扣回行（决定要不要刷新余额缓存）。 */
async function settleRefundDone(tx: Tx, order: Order, refundId: string, input: RefundInput, doneBefore: number): Promise<boolean> {
  await tx.update(refunds).set({ status: "done" }).where(and(eq(refunds.id, refundId), eq(refunds.status, "pending")))
  const doneTotal = doneBefore + input.amountCents
  if (doneTotal >= order.amountCents) {
    await tx.update(paymentOrders).set({ status: "refunded" }).where(and(eq(paymentOrders.id, order.id), eq(paymentOrders.status, "paid")))
    // 会员单退满 ⇒ 同事务抵消这一次顺延，否则就是「钱退了、会员还在」
    if (order.type === "renewal") await rollbackSubscriptionCycle(tx, order)
  }

  const grantedCredits = await sumGrantedCredits(tx, order.id)
  if (grantedCredits <= 0) return false

  const [clawed] = await tx
    .select({ total: sql<number>`coalesce(sum(${creditTransactions.amount}), 0)` })
    .from(creditTransactions)
    .where(and(eq(creditTransactions.ref, order.id), eq(creditTransactions.type, "refund_clawback")))
  const alreadyClawed = -Number(clawed?.total ?? 0)
  // 累计口径：本笔 = 目标 − 已扣回（取整误差不随笔数累积/放大）
  const clawback = clawbackTarget(grantedCredits, doneTotal, order.amountCents) - alreadyClawed
  if (clawback <= 0) return false

  await tx
    .insert(creditTransactions)
    .values({
      userId: order.userId,
      type: "refund_clawback", // 负向注销已入账积分；不借 release（hold 退还净 0 语义）
      amount: -clawback,
      ref: order.id,
      idempotencyKey: `refund_clawback:${refundId}`,
    })
    .onConflictDoNothing({ target: creditTransactions.idempotencyKey })
  return true
}

/**
 * 建退款并执行：① 行锁校验 + 建 pending；② 调通道（refundSn=refunds.id，通道侧幂等）；
 * ③ 明确成功 → done 落账（订单翻转/扣回积分同事务）；明确业务拒绝 → failed；
 *    **抛错（网络/超时等歧义结果）→ 保持 pending**，由 scanStuckRefunds 落差异转人工。
 */
export async function createRefund(
  rawInput: RefundInput,
  deps: { provider: RefundProvider },
): Promise<{ refundId: string; status: "done" | "failed" | "pending"; reason?: string }> {
  const input = InputSchema.parse(rawInput)
  const { order, refundId, doneBefore, replayedStatus } = await validateAndCreatePending(input)
  if (replayedStatus) return { refundId, status: replayedStatus } // 幂等重放：返回既有退款结果，不再走通道/扣回

  // 扣回护栏前置估算：全额/部分退款要扣的积分若超当前余额（用户已花掉），默认拒绝——操作员须显式确认
  if (!input.allowNegativeBalance) {
    const balance = await getBalance(order.userId)
    const estimate = clawbackTarget(await sumGrantedCredits(getDb(), order.id), input.amountCents, order.amountCents)
    if (estimate > balance) {
      // 未触发通道调用 → 标 failed 安全；但**必须同时释放幂等键**：这行拿着键的话，操作员按提示
      // 携 allowNegativeBalance 用同一个键重试会被判成「幂等重放」，直接回上次的 failed——
      // 不调通道、不带原因，点了确认等于什么都没发生（2026-07-31 生产实测，界面显示
      // 「通道拒绝，未返回原因」，而通道根本没被调用过）。
      // 幂等键的职责是挡住重复的**通道调用**；这里一次都没调过，键就不该继续占着。
      await getDb().update(refunds).set({ status: "failed", idempotencyKey: null }).where(eq(refunds.id, refundId))
      throw new Error(`扣回积分 ${estimate} 超过当前余额 ${balance}（用户已消费）：需操作员确认后携 allowNegativeBalance 重试`)
    }
  }

  // ② 通道退款（不在事务内：外部 IO 不能占着行锁）
  let outcome: "ok" | "rejected" | "ambiguous" = "ok"
  let providerError: string | undefined
  try {
    const res = await deps.provider.refund({ clientSn: order.clientSn, refundSn: refundRequestNo(refundId), amountCents: input.amountCents })
    outcome = res.ok ? "ok" : "rejected"
    providerError = res.reason
    // 通道返回原样留痕（2026-07-31）：那天三次退款的审计里 reason 都是空，界面只显示「通道拒绝，
    // 未返回原因」，而直连同一 provider 探测拿得到「今日新收款余额小于退款额[EP36]」，
    // 适配器的「无原因就打原始报文」也没触发——原因确实产生了却没到界面，断点不明。
    // 这行把边界上的真值记下来，下次失败直接看日志，不必再靠推断。
    if (!res.ok) {
      console.error(`[refund] 通道返回 refund=${refundId} ok=${res.ok} reason=${JSON.stringify(res.reason)}`)
    }
  } catch (e) {
    outcome = "ambiguous"
    providerError = (e as Error).message
  }

  if (outcome === "ambiguous") {
    // 通道可能已退款：不标 failed（防换 refundSn 重试双退）；pending 占额度，scanStuckRefunds 转人工
    console.error(`[refund] 通道结果不明（保持 pending 待人工核对）refund=${refundId}`, providerError)
    auditLog({ operator: input.operator, action: "refund.ambiguous", orderId: order.id, before: { orderStatus: order.status }, after: { refundId, refundStatus: "pending", error: providerError } })
    return { refundId, status: "pending", reason: providerError }
  }
  if (outcome === "rejected") {
    await getDb().update(refunds).set({ status: "failed" }).where(and(eq(refunds.id, refundId), eq(refunds.status, "pending")))
    auditLog({ operator: input.operator, action: "refund.failed", orderId: order.id, before: { orderStatus: order.status }, after: { refundId, refundStatus: "failed", error: providerError } })
    return { refundId, status: "failed", reason: providerError }
  }

  const clawed = await getDb().transaction((tx) => settleRefundDone(tx, order, refundId, input, doneBefore))
  if (clawed) await getBalance(order.userId) // 出事务后刷新余额缓存（审计口径一致）；幂等命中/无扣回不重算
  auditLog({ operator: input.operator, action: "refund.done", orderId: order.id, before: { orderStatus: "paid" }, after: { refundId, amountCents: input.amountCents } })
  return { refundId, status: "done" }
}
