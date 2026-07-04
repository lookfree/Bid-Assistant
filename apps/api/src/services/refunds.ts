import { z } from "zod"
import { and, eq, inArray, sql } from "drizzle-orm"
import { getDb } from "../db/client"
import { paymentOrders, refunds, creditTransactions } from "../db/schema"
import { getBalance } from "./credits"
import type { PaymentProvider } from "./payment/provider"

// 退款编排（架构 §6.2(D)，spec306）：唯一入口收口到 spec310 POST /admin-api/refunds（过 admin RBAC+审计），
// 本模块只产出 service，不建路由——避免出现绕过 RBAC/审计的并行退款入口。
// 铁律：只退 paid 单；累计退款额（pending+done）≤ 订单额（并发双退在护栏处挡住）；
// renewal 单拒绝自动退款转人工（退钱必须同时处置已顺延的订阅周期，决策 review-followups C9）；
// 扣回积分写负向 refund_clawback 流水（不借 release——那是 hold 退还净 0 语义），幂等键 refund_clawback:<refundId>。

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
})
export type RefundInput = z.infer<typeof InputSchema>

/**
 * 建退款并执行：① 事务内校验（paid 单/非 renewal/累计额护栏）+ 建 refunds(pending)；
 * ② 调通道退款（refundSn=refunds.id，通道侧幂等——同号重试不重复退）；
 * ③ 成功：done + 订单置 refunded + 按退款比例扣回该订单已入账积分（负向 refund_clawback，幂等）；
 * ④ 失败：failed，订单/积分不动。
 * 校验不过直接抛错（不建 provider 调用）；扣回可能使余额为负（用户已花掉），账本允许并由审计可见。
 */
export async function createRefund(
  rawInput: RefundInput,
  deps: { provider: RefundProvider },
): Promise<{ refundId: string; status: "done" | "failed" }> {
  const input = InputSchema.parse(rawInput)

  // ① 校验 + 建 pending（同事务：累计额护栏必须与建单原子，否则并发双退各自读到旧累计）
  const { order, refundId } = await getDb().transaction(async (tx) => {
    const [order] = await tx.select().from(paymentOrders).where(eq(paymentOrders.id, input.orderId)).for("update")
    if (!order) throw new Error("订单不存在")
    if (order.status !== "paid") throw new Error(`订单状态非 paid：${order.status}`)
    if (order.type === "renewal") {
      // C9 决策：renewal 结算已顺延周期/复活状态，只退钱不回退周期=退钱留会员 → 转人工处置
      throw new Error("renewal 单不支持自动退款（须同时处置订阅周期），请转人工")
    }
    const [agg] = await tx
      .select({ total: sql<number>`coalesce(sum(${refunds.amountCents}), 0)` })
      .from(refunds)
      .where(and(eq(refunds.orderId, order.id), inArray(refunds.status, ["pending", "done"]))) // pending 计入：挡并发双退
    const already = Number(agg?.total ?? 0)
    if (input.amountCents + already > order.amountCents) {
      throw new Error(`累计退款额超过订单额：已退/在途 ${already} + 本次 ${input.amountCents} > ${order.amountCents}`)
    }
    const [r] = await tx
      .insert(refunds)
      .values({ orderId: order.id, amountCents: input.amountCents, reason: input.reason, status: "pending", operator: input.operator })
      .returning()
    return { order, refundId: r!.id }
  })

  // ② 通道退款（不在事务内：外部 IO 不能占着行锁）
  let ok: boolean
  let providerError: string | undefined
  try {
    ok = (await deps.provider.refund({ clientSn: order.clientSn, refundSn: refundId, amountCents: input.amountCents })).ok
  } catch (e) {
    ok = false
    providerError = (e as Error).message
  }

  if (!ok) {
    await getDb().update(refunds).set({ status: "failed" }).where(and(eq(refunds.id, refundId), eq(refunds.status, "pending")))
    auditLog({
      operator: input.operator,
      action: "refund.failed",
      orderId: order.id,
      before: { orderStatus: order.status },
      after: { refundId, refundStatus: "failed", error: providerError },
    })
    return { refundId, status: "failed" }
  }

  // ③ 成功落账（同事务：退款单/订单状态/积分扣回一起提交）
  await getDb().transaction(async (tx) => {
    await tx.update(refunds).set({ status: "done" }).where(and(eq(refunds.id, refundId), eq(refunds.status, "pending")))
    await tx.update(paymentOrders).set({ status: "refunded" }).where(and(eq(paymentOrders.id, order.id), eq(paymentOrders.status, "paid")))

    // 该订单曾入账的正向积分（充值到账等，ref=order.id）→ 按退款比例扣回
    const [granted] = await tx
      .select({ total: sql<number>`coalesce(sum(${creditTransactions.amount}), 0)` })
      .from(creditTransactions)
      .where(and(eq(creditTransactions.ref, order.id), sql`${creditTransactions.amount} > 0`))
    const grantedCredits = Number(granted?.total ?? 0)
    if (grantedCredits > 0) {
      const clawback = Math.round(grantedCredits * (input.amountCents / order.amountCents))
      if (clawback > 0) {
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
      }
    }
  })
  await getBalance(order.userId) // 出事务后刷新余额缓存（审计口径一致）

  auditLog({
    operator: input.operator,
    action: "refund.done",
    orderId: order.id,
    before: { orderStatus: "paid" },
    after: { orderStatus: "refunded", refundId, amountCents: input.amountCents },
  })
  return { refundId, status: "done" }
}
