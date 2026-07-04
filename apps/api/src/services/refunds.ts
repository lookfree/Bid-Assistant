import { z } from "zod"
import { and, eq, inArray, sql } from "drizzle-orm"
import { getDb } from "../db/client"
import { paymentOrders, refunds, creditTransactions } from "../db/schema"
import { getBalance } from "./credits"
import type { PaymentProvider } from "./payment/provider"
import type { Tx } from "./credits"

// 退款编排（架构 §6.2(D)，spec306）：唯一入口收口到 spec310 POST /admin-api/refunds（过 admin RBAC+审计），
// 本模块只产出 service，不建路由——避免出现绕过 RBAC/审计的并行退款入口。
// 铁律：
// - 只退 paid 单；累计退款额（pending+done）≤ 订单额（并发双退在护栏处挡住）；
// - renewal 单拒绝自动退款转人工（退钱必须同时处置已顺延的订阅周期，决策 review-followups C9）；
// - 通道调用**抛错 ≠ 失败**：网络超时时通道可能已实际退款，标 failed 会让重试换新 refundSn 双退真钱
//   ——歧义结果留 pending（占用累计额度挡住重试），由 scanStuckRefunds 落差异转人工核对；
// - 扣回积分写负向 refund_clawback 流水（不借 release——那是 hold 退还净 0 语义），幂等键 refund_clawback:<refundId>；
//   多次部分退款按**累计比例**计算（每笔=round(总入账×累计退款比例)−已扣回），取整误差不随笔数放大；
// - 扣回超过当前余额（用户已花掉）默认拒绝，操作员确认后带 allowNegativeBalance 强制（余额转负，审计可见）。

/** 退款只需要 refund 能力：Pick 收窄，便于注入 mock。 */
export type RefundProvider = Pick<PaymentProvider, "refund">

// TODO(spec310)：接 admin_audit_logs 审计装置（operator + 前后值）；当前 operator 落 refunds + console 审计
function auditLog(entry: { operator: string; action: string; orderId: string; before: unknown; after: unknown }) {
  console.info("[audit]", JSON.stringify(entry))
}

const InputSchema = z.object({
  orderId: z.string().uuid(),
  amountCents: z.number().int().positive(),
  reason: z.string(),
  operator: z.string().min(1),
  allowNegativeBalance: z.boolean().optional(), // 扣回>余额时需操作员显式确认
})
export type RefundInput = z.infer<typeof InputSchema>

type Order = typeof paymentOrders.$inferSelect

/** ① 事务：行锁下校验（paid/非 renewal/累计额）+ 建 pending。校验不过抛错，不触发通道调用。 */
async function validateAndCreatePending(input: RefundInput): Promise<{ order: Order; refundId: string; doneBefore: number }> {
  return await getDb().transaction(async (tx) => {
    const [order] = await tx.select().from(paymentOrders).where(eq(paymentOrders.id, input.orderId)).for("update")
    if (!order) throw new Error("订单不存在")
    if (order.status !== "paid") throw new Error(`订单状态非 paid：${order.status}`)
    if (order.type === "renewal") {
      // C9 决策：renewal 结算已顺延周期/复活状态，只退钱不回退周期=退钱留会员 → 转人工处置
      throw new Error("renewal 单不支持自动退款（须同时处置订阅周期），请转人工")
    }
    const rows = await tx
      .select({ amountCents: refunds.amountCents, status: refunds.status })
      .from(refunds)
      .where(and(eq(refunds.orderId, order.id), inArray(refunds.status, ["pending", "done"]))) // pending 计入：挡并发双退与歧义未决
    const already = rows.reduce((s, r) => s + r.amountCents, 0)
    if (input.amountCents + already > order.amountCents) {
      throw new Error(`累计退款额超过订单额：已退/在途 ${already} + 本次 ${input.amountCents} > ${order.amountCents}`)
    }
    const [r] = await tx
      .insert(refunds)
      .values({ orderId: order.id, amountCents: input.amountCents, reason: input.reason, status: "pending", operator: input.operator })
      .returning()
    const doneBefore = rows.filter((x) => x.status === "done").reduce((s, x) => s + x.amountCents, 0)
    return { order, refundId: r!.id, doneBefore }
  })
}

/** ③ 成功落账（事务）：退款单 done + 累计退满才翻订单 refunded（部分退款订单留 paid，剩余额度可继续退）
 *  + 按累计比例扣回积分。返回是否插入了扣回行（决定要不要刷新余额缓存）。 */
async function settleRefundDone(tx: Tx, order: Order, refundId: string, input: RefundInput, doneBefore: number): Promise<boolean> {
  await tx.update(refunds).set({ status: "done" }).where(and(eq(refunds.id, refundId), eq(refunds.status, "pending")))
  const doneTotal = doneBefore + input.amountCents
  if (doneTotal >= order.amountCents) {
    await tx.update(paymentOrders).set({ status: "refunded" }).where(and(eq(paymentOrders.id, order.id), eq(paymentOrders.status, "paid")))
  }

  const [granted] = await tx
    .select({ total: sql<number>`coalesce(sum(${creditTransactions.amount}), 0)` })
    .from(creditTransactions)
    .where(and(eq(creditTransactions.ref, order.id), sql`${creditTransactions.amount} > 0`))
  const grantedCredits = Number(granted?.total ?? 0)
  if (grantedCredits <= 0) return false

  const [clawed] = await tx
    .select({ total: sql<number>`coalesce(sum(${creditTransactions.amount}), 0)` })
    .from(creditTransactions)
    .where(and(eq(creditTransactions.ref, order.id), eq(creditTransactions.type, "refund_clawback")))
  const alreadyClawed = -Number(clawed?.total ?? 0)
  // 累计口径：目标扣回 = round(总入账 × 累计退款比例)；本笔 = 目标 − 已扣回（取整误差不随笔数累积/放大）
  const clawback = Math.round((grantedCredits * doneTotal) / order.amountCents) - alreadyClawed
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
export async function createRefund(rawInput: RefundInput, deps: { provider: RefundProvider }): Promise<{ refundId: string; status: "done" | "failed" | "pending" }> {
  const input = InputSchema.parse(rawInput)
  const { order, refundId, doneBefore } = await validateAndCreatePending(input)

  // 扣回护栏前置估算：全额/部分退款要扣的积分若超当前余额（用户已花掉），默认拒绝——操作员须显式确认
  if (!input.allowNegativeBalance) {
    const balance = await getBalance(order.userId)
    const [granted] = await getDb()
      .select({ total: sql<number>`coalesce(sum(${creditTransactions.amount}), 0)` })
      .from(creditTransactions)
      .where(and(eq(creditTransactions.ref, order.id), sql`${creditTransactions.amount} > 0`))
    const estimate = Math.round((Number(granted?.total ?? 0) * input.amountCents) / order.amountCents)
    if (estimate > balance) {
      await getDb().update(refunds).set({ status: "failed" }).where(eq(refunds.id, refundId)) // 未触发通道调用，failed 安全
      throw new Error(`扣回积分 ${estimate} 超过当前余额 ${balance}（用户已消费）：需操作员确认后携 allowNegativeBalance 重试`)
    }
  }

  // ② 通道退款（不在事务内：外部 IO 不能占着行锁）
  let outcome: "ok" | "rejected" | "ambiguous" = "ok"
  let providerError: string | undefined
  try {
    outcome = (await deps.provider.refund({ clientSn: order.clientSn, refundSn: refundId, amountCents: input.amountCents })).ok ? "ok" : "rejected"
  } catch (e) {
    outcome = "ambiguous"
    providerError = (e as Error).message
  }

  if (outcome === "ambiguous") {
    // 通道可能已退款：不标 failed（防换 refundSn 重试双退）；pending 占额度，scanStuckRefunds 转人工
    console.error(`[refund] 通道结果不明（保持 pending 待人工核对）refund=${refundId}`, providerError)
    auditLog({ operator: input.operator, action: "refund.ambiguous", orderId: order.id, before: { orderStatus: order.status }, after: { refundId, refundStatus: "pending", error: providerError } })
    return { refundId, status: "pending" }
  }
  if (outcome === "rejected") {
    await getDb().update(refunds).set({ status: "failed" }).where(and(eq(refunds.id, refundId), eq(refunds.status, "pending")))
    auditLog({ operator: input.operator, action: "refund.failed", orderId: order.id, before: { orderStatus: order.status }, after: { refundId, refundStatus: "failed" } })
    return { refundId, status: "failed" }
  }

  const clawed = await getDb().transaction((tx) => settleRefundDone(tx, order, refundId, input, doneBefore))
  if (clawed) await getBalance(order.userId) // 出事务后刷新余额缓存（审计口径一致）；幂等命中/无扣回不重算
  auditLog({ operator: input.operator, action: "refund.done", orderId: order.id, before: { orderStatus: "paid" }, after: { refundId, amountCents: input.amountCents } })
  return { refundId, status: "done" }
}
