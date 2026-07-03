import { pgTable, uuid, text, integer, jsonb, index, unique, check } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { id, createdAt, tz } from "./columns"
import { users } from "./users"

// 套餐：所有数值由配置/运营后台注入（price_cents/grant 等留默认 0，不写死真实定价）。
export const plans = pgTable("plans", {
  id: id(),
  name: text("name").notNull(),
  priceCents: integer("price_cents").notNull().default(0), // 价格（分，integer——金额全链路禁浮点）
  currency: text("currency").notNull().default("CNY"),
  billingCycle: text("billing_cycle").notNull(), // month/quarter/year
  grantCreditsPerCycle: integer("grant_credits_per_cycle").notNull().default(0),
  features: jsonb("features").$type<Record<string, unknown>>().default({}), // 权益开关
  limits: jsonb("limits").$type<Record<string, unknown>>().default({}), // 并发/项目数上限
  status: text("status").notNull().default("active"), // active(上架)/archived(下架)
  version: integer("version").notNull().default(1),
  createdAt: createdAt(),
}, (t) => ({
  // billing_cycle 驱动续期周期计算（spec305），typo 直接断续费链路
  cycleCheck: check("plans_billing_cycle_check", sql`${t.billingCycle} in ('month','quarter','year')`),
}))

// 订阅：无 auto_renew/agreement_no——不做自动续费（架构 §6.2，到期提醒+手动续费）。
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id),
    status: text("status").notNull().default("active"), // active/past_due/expired
    currentPeriodStart: tz("current_period_start"),
    currentPeriodEnd: tz("current_period_end"),
    createdAt: createdAt(),
  },
  (t) => ({
    userIdx: index("subscriptions_user_idx").on(t.userId),
    statusCheck: check("subscriptions_status_check", sql`${t.status} in ('active','past_due','expired')`),
  }),
)

// 到期提醒发送记录（spec305）：同一订阅同一周期同一档只提醒一次——唯一约束落库去重，
// Cron 双触发/重启重扫都不会重复骚扰用户；续费后 period_end 变化 → 新周期各档重新计。
export const renewalReminders = pgTable(
  "renewal_reminders",
  {
    id: id(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    periodEnd: tz("period_end").notNull(), // 提醒针对的周期末
    tier: integer("tier").notNull(), // 提醒档（T-N 天，如 7/3/1）
    createdAt: createdAt(),
  },
  (t) => ({
    uq: unique("renewal_reminders_uq").on(t.subscriptionId, t.periodEnd, t.tier),
  }),
)
