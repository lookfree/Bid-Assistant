import { pgTable, uuid, text, integer, jsonb, unique, uniqueIndex, check } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { id, createdAt, tz } from "./columns"
import { users } from "./users"

// 套餐：所有数值由配置/运营后台注入（price_cents/grant 等留默认 0，不写死真实定价）。
export const plans = pgTable("plans", {
  id: id(),
  name: text("name").notNull(),
  code: text("code"), // 档位标识 free/personal/professional（spec308 会员中心分组；同档不同 cycle 行共享同 code）
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
  // 档位标识只允许固定枚举（NULL=非会员档套餐，如纯充值不入会员分组）
  codeCheck: check("plans_code_check", sql`${t.code} is null or ${t.code} in ('free','personal','professional')`),
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
    // 一人一订阅行（当前周期唯一真相，历史在 payment_orders）：这也是续费入账的串行化前提——
    // 并发首次续费靠它挡掉双 INSERT，renewOnPaid 再对该行 FOR UPDATE 排队
    userUq: uniqueIndex("subscriptions_user_uq").on(t.userId),
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
