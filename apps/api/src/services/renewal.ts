import { and, eq, gt, isNotNull, lte } from "drizzle-orm"
import { getDb } from "../db/client"
import { plans, subscriptions, renewalReminders } from "../db/schema"
import { getConfig, pickNonNegative } from "./config"
import * as credits from "./credits"
import type { Tx } from "./credits"

// 会员到期提醒 + 手动续费闭环（架构 §6.2，无自动续费/代扣）：
// - 状态机单向 active→past_due→expired，Cron 条件 UPDATE 推进（宽限期 renewal_grace_days 可配）；
// - 续费入账 renewOnPaid 由 spec304 markPaid(type=renewal) 在同一事务内调用：
//   续期与发放当期积分一起提交，失败整体回滚由通道重试重新驱动（沿用 markPaid 原子性契约）；
//   权益（周期/积分）用订单快照——「这笔钱买什么」在下单时刻锁定，运营改配置不影响在途单；
// - 并发续费串行化点：subscriptions 一人一行（唯一索引）+ FOR UPDATE 行锁（spec302 lockUserBalanceRow 同款），
//   两笔并发续费排队叠加周期（付两周期得两周期），杜绝同 base 双写丢周期；
// - 提醒幂等：renewal_reminders 唯一约束(订阅,周期末,档) 落库去重，Cron 双触发不骚扰用户。

export const DAY_MS = 86_400_000

/** 自然月顺延（UTC 运算，月末夹紧：1/31 +1月 → 2/28）。
 *  必须钉死 UTC：本地时区运算会让同一 UTC 时刻在不同部署时区取到不同「日」，周期末漂移一天。 */
function addMonthsUtc(base: Date, months: number): Date {
  const day = base.getUTCDate()
  const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + months + 1, 0)).getUTCDate()
  return new Date(
    Date.UTC(
      base.getUTCFullYear(),
      base.getUTCMonth() + months,
      Math.min(day, lastDay),
      base.getUTCHours(),
      base.getUTCMinutes(),
      base.getUTCSeconds(),
      base.getUTCMilliseconds(),
    ),
  )
}

/** billing_cycle → 周期顺延。未知周期抛错（plans 有 CHECK 约束，走到这里是数据事故）。 */
function addCycle(base: Date, cycle: string): Date {
  if (cycle === "month") return addMonthsUtc(base, 1)
  if (cycle === "quarter") return addMonthsUtc(base, 3)
  if (cycle === "year") return addMonthsUtc(base, 12)
  throw new Error(`未知计费周期 ${cycle}`)
}

/**
 * 续费入账（markPaid renewal 分支，事务内调用）：
 * 1) 权益以订单快照为准（cycleSnapshot/creditsSnapshot）；缺快照的存量单回退套餐当前值并告警；
 * 2) 串行化：先占位建行（唯一索引挡并发双 INSERT）再 FOR UPDATE 锁行——并发两单排队，
 *    第二单以第一单顺延后的 periodEnd 为 base，周期正确叠加；
 * 3) 未过期从 current_period_end 顺延（不吞剩余天数）；已过期/无订阅从支付时刻起新周期；
 *    past_due/expired 复活为 active；
 * 4) 发放当期赠送积分：幂等键 renewal:<orderId>，expireAt=新周期末（当期积分当期用，随周期作废）。
 * 缺 plan_id 抛错 → markPaid 整体回滚，订单保持可重驱动（钱不落错账）。
 */
export async function renewOnPaid(
  order: { orderId: string; userId: string; planId: string | null; creditsSnapshot: number | null; cycleSnapshot: string | null },
  tx: Tx,
  deps: { grantFn?: typeof credits.grant } = {},
): Promise<void> {
  if (!order.planId) throw new Error(`renewal 单缺 plan_id：${order.orderId}`)
  let cycle = order.cycleSnapshot
  let cycleCredits = order.creditsSnapshot
  if (cycle == null || cycleCredits == null) {
    // 快照缺失（快照列上线前的存量单）：回退套餐当前值。新单一律带快照（createOrder/路由保证）
    const [plan] = await tx.select().from(plans).where(eq(plans.id, order.planId))
    if (!plan) throw new Error(`renewal 套餐不存在：${order.planId}`)
    cycle ??= plan.billingCycle
    cycleCredits ??= plan.grantCreditsPerCycle
    console.error(`[renewal] 订单缺权益快照，回退套餐当前值 order=${order.orderId}（不应出现在新单）`)
  }

  // —— 并发续费串行化点：占位（唯一索引兜底）+ FOR UPDATE ——
  await tx
    .insert(subscriptions)
    .values({ userId: order.userId, planId: order.planId, status: "active" })
    .onConflictDoNothing({ target: subscriptions.userId })
  const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.userId, order.userId)).for("update")
  if (!sub) throw new Error(`订阅行占位失败 user=${order.userId}`)

  const now = new Date()
  const base = sub.currentPeriodEnd && sub.currentPeriodEnd > now ? sub.currentPeriodEnd : now
  const newEnd = addCycle(base, cycle)
  await tx
    .update(subscriptions)
    .set({ status: "active", planId: order.planId, currentPeriodStart: base, currentPeriodEnd: newEnd })
    .where(eq(subscriptions.id, sub.id))

  if (cycleCredits > 0) {
    await (deps.grantFn ?? credits.grant)(
      order.userId,
      cycleCredits,
      {
        type: "grant",
        sourceBatch: order.orderId,
        ref: order.orderId,
        expireAt: newEnd,
        idempotencyKey: `renewal:${order.orderId}`, // 与订单一一对应，重复驱动不重复发放
      },
      tx,
    )
  }
}

/**
 * 订阅状态机推进（Cron job 体）：active 到期→past_due；past_due 超宽限→expired。
 * 条件 UPDATE 幂等；current_period_end 为 NULL 的行不推进（L1 null-guard）。
 * 一轮内可跨档：过期远超宽限的 active 先落 past_due 再被第二个 UPDATE 收进 expired。
 */
export async function advanceSubscriptionStates(now: Date = new Date()): Promise<{ pastDue: number; expired: number }> {
  const graceDays = pickNonNegative(await getConfig("renewal_grace_days"), 3)
  const pastDue = await getDb()
    .update(subscriptions)
    .set({ status: "past_due" })
    .where(and(eq(subscriptions.status, "active"), isNotNull(subscriptions.currentPeriodEnd), lte(subscriptions.currentPeriodEnd, now)))
    .returning({ id: subscriptions.id })
  const graceCutoff = new Date(now.getTime() - graceDays * DAY_MS)
  const expired = await getDb()
    .update(subscriptions)
    .set({ status: "expired" })
    .where(
      and(eq(subscriptions.status, "past_due"), isNotNull(subscriptions.currentPeriodEnd), lte(subscriptions.currentPeriodEnd, graceCutoff)),
    )
    .returning({ id: subscriptions.id })
  return { pastDue: pastDue.length, expired: expired.length }
}

export type ReminderNotice = { userId: string; subscriptionId: string; periodEnd: Date; tierDays: number }

/**
 * 到期提醒扫描（Cron job 体）：只扫 active 且周期末在 (now, now+最大档] 的订阅。
 * 一次只发**最紧迫的一档**（临到期才订阅的用户不被 T-7/T-3/T-1 连环轰炸；被跳过的外档不补发）。
 * 幂等与可靠性：先落 renewal_reminders 再通知；notify 失败则**删除去重行**（下轮重试）并继续下一条
 * ——单个坏号码不毒死整轮，也不白耗档位。进程在「落行后、通知前」崩溃的窄窗仍是 at-most-once
 * （宁可漏一条不重复骚扰，见 review-followups）。
 * notify 渠道必须显式注入（crons/renewal.ts 无渠道不注册本 job——console 假发送等于静默吞提醒）。
 */
export async function scanRenewalReminders(now: Date, deps: { notify: (n: ReminderNotice) => Promise<void> }): Promise<number> {
  const raw = await getConfig<unknown>("renewal_reminder_days")
  const tiers = (Array.isArray(raw) ? raw : [7, 3, 1]) // 形状错误（标量/对象）回落默认：raw.filter 抛错会永久断提醒
    .filter((t): t is number => typeof t === "number" && Number.isFinite(t) && t > 0)
    .sort((a, b) => b - a)
  if (tiers.length === 0) return 0

  const horizon = new Date(now.getTime() + tiers[0]! * DAY_MS)
  const due = await getDb()
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.status, "active"), // past_due/expired 不打扰（状态机/召回是另一回事）
        isNotNull(subscriptions.currentPeriodEnd),
        gt(subscriptions.currentPeriodEnd, now), // 已到期交给状态机
        lte(subscriptions.currentPeriodEnd, horizon),
      ),
    )

  let sent = 0
  for (const sub of due) {
    const end = sub.currentPeriodEnd!
    const matched = tiers.filter((t) => end.getTime() <= now.getTime() + t * DAY_MS)
    const tier = Math.min(...matched) // 最紧迫的一档
    const inserted = await getDb()
      .insert(renewalReminders)
      .values({ subscriptionId: sub.id, periodEnd: end, tier })
      .onConflictDoNothing() // 唯一约束(订阅,周期末,档)：该档已提醒过 → 幂等跳过
      .returning({ id: renewalReminders.id })
    if (inserted.length === 0) continue
    try {
      await deps.notify({ userId: sub.userId, subscriptionId: sub.id, periodEnd: end, tierDays: tier })
      sent++
    } catch (err) {
      console.error(`[renewal] 提醒发送失败，回滚去重记录待下轮重试 sub=${sub.id} T-${tier}`, err)
      await getDb().delete(renewalReminders).where(eq(renewalReminders.id, inserted[0]!.id)).catch(() => {}) // 补偿删除
    }
  }
  return sent
}
