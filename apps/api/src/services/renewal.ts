import { and, desc, eq, gt, isNotNull, lte } from "drizzle-orm"
import { getDb } from "../db/client"
import { plans, subscriptions, renewalReminders } from "../db/schema"
import { getConfig } from "./config"
import * as credits from "./credits"
import type { Tx } from "./credits"

// 会员到期提醒 + 手动续费闭环（架构 §6.2，无自动续费/代扣）：
// - 状态机单向 active→past_due→expired，Cron 条件 UPDATE 推进（宽限期 renewal_grace_days 可配）；
// - 续费入账 renewOnPaid 由 spec304 markPaid(type=renewal) 在同一事务内调用：
//   续期与发放当期积分一起提交，失败整体回滚由通道重试重新驱动（沿用 markPaid 原子性契约）；
// - 提醒幂等：renewal_reminders 唯一约束(订阅,周期末,档) 落库去重，Cron 双触发不骚扰用户。

const DAY_MS = 86_400_000

/** 自然月顺延（月末夹紧：1/31 +1月 → 2/28，不溢出到 3 月）。 */
function addMonths(base: Date, months: number): Date {
  const d = new Date(base)
  const day = d.getDate()
  d.setDate(1)
  d.setMonth(d.getMonth() + months)
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  d.setDate(Math.min(day, lastDay))
  return d
}

/** billing_cycle → 周期顺延。未知周期抛错（plans 有 CHECK 约束，走到这里是数据事故）。 */
function addCycle(base: Date, cycle: string): Date {
  if (cycle === "month") return addMonths(base, 1)
  if (cycle === "quarter") return addMonths(base, 3)
  if (cycle === "year") return addMonths(base, 12)
  throw new Error(`未知计费周期 ${cycle}`)
}

/**
 * 续费入账（markPaid renewal 分支，事务内调用）：
 * - 续期基准：未过期从 current_period_end 顺延（不吞剩余天数）；已过期/无订阅从支付时刻起新周期；
 * - past_due/expired 复活为 active；无订阅行直接建新订阅（首次经续费入口购买也不丢单）；
 * - 发放套餐当期赠送积分：幂等键 renewal:<orderId>，expireAt=新周期末（当期积分当期用，随周期作废）。
 * 缺 plan_id / 套餐不存在直接抛错 → markPaid 整体回滚，订单保持可重驱动（钱不落错账）。
 */
export async function renewOnPaid(
  order: { orderId: string; userId: string; planId: string | null },
  tx: Tx,
  deps: { grantFn?: typeof credits.grant } = {},
): Promise<void> {
  if (!order.planId) throw new Error(`renewal 单缺 plan_id：${order.orderId}`)
  const [plan] = await tx.select().from(plans).where(eq(plans.id, order.planId))
  if (!plan) throw new Error(`renewal 套餐不存在：${order.planId}`)

  const now = new Date()
  const [sub] = await tx
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, order.userId))
    .orderBy(desc(subscriptions.createdAt))
    .limit(1)
  const base = sub?.currentPeriodEnd && sub.currentPeriodEnd > now ? sub.currentPeriodEnd : now
  const newEnd = addCycle(base, plan.billingCycle)

  if (sub) {
    await tx
      .update(subscriptions)
      .set({ status: "active", planId: plan.id, currentPeriodStart: base, currentPeriodEnd: newEnd })
      .where(eq(subscriptions.id, sub.id))
  } else {
    await tx
      .insert(subscriptions)
      .values({ userId: order.userId, planId: plan.id, status: "active", currentPeriodStart: base, currentPeriodEnd: newEnd })
  }

  if (plan.grantCreditsPerCycle > 0) {
    await (deps.grantFn ?? credits.grant)(
      order.userId,
      plan.grantCreditsPerCycle,
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
  const raw = await getConfig<number>("renewal_grace_days")
  const graceDays = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 3
  const pastDue = await getDb()
    .update(subscriptions)
    .set({ status: "past_due" })
    .where(and(eq(subscriptions.status, "active"), isNotNull(subscriptions.currentPeriodEnd), lte(subscriptions.currentPeriodEnd, now)))
    .returning()
  const graceCutoff = new Date(now.getTime() - graceDays * DAY_MS)
  const expired = await getDb()
    .update(subscriptions)
    .set({ status: "expired" })
    .where(
      and(eq(subscriptions.status, "past_due"), isNotNull(subscriptions.currentPeriodEnd), lte(subscriptions.currentPeriodEnd, graceCutoff)),
    )
    .returning()
  return { pastDue: pastDue.length, expired: expired.length }
}

export type ReminderNotice = { userId: string; subscriptionId: string; periodEnd: Date; tierDays: number }

/**
 * 到期提醒扫描（Cron job 体）：只扫 active 且周期末在 (now, now+最大档] 的订阅。
 * 一次只发**最紧迫的一档**（临到期才订阅的用户不被 T-7/T-3/T-1 连环轰炸）；
 * 每档先落 renewal_reminders 再通知（at-most-once：崩溃宁可漏一条，不重复骚扰）。
 * notify 渠道可注入；默认 console（短信/站内信模板就绪后替换，接口不变）。
 */
export async function scanRenewalReminders(
  now: Date = new Date(),
  deps: { notify?: (n: ReminderNotice) => Promise<void> } = {},
): Promise<number> {
  const raw = (await getConfig<number[]>("renewal_reminder_days")) ?? [7, 3, 1]
  const tiers = raw.filter((t) => typeof t === "number" && Number.isFinite(t) && t > 0).sort((a, b) => b - a)
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
  const notify =
    deps.notify ??
    (async (n: ReminderNotice) => console.log(`[renewal] 到期提醒 user=${n.userId} T-${n.tierDays} 周期末 ${n.periodEnd.toISOString()}`))

  let sent = 0
  for (const sub of due) {
    const end = sub.currentPeriodEnd!
    const matched = tiers.filter((t) => end.getTime() <= now.getTime() + t * DAY_MS)
    const tier = Math.min(...matched) // 最紧迫的一档
    const inserted = await getDb()
      .insert(renewalReminders)
      .values({ subscriptionId: sub.id, periodEnd: end, tier })
      .onConflictDoNothing() // 唯一约束(订阅,周期末,档)：该档已提醒过 → 幂等跳过
      .returning()
    if (inserted.length === 0) continue
    await notify({ userId: sub.userId, subscriptionId: sub.id, periodEnd: end, tierDays: tier })
    sent++
  }
  return sent
}
