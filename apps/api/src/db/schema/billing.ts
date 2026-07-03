import { pgTable, uuid, text, jsonb, index, unique } from "drizzle-orm/pg-core"
import { id, createdAt, tz } from "./columns"
import { users } from "./users"

// 邀请关系：一个被邀请人只属一个邀请关系（invitee 唯一）。
export const referrals = pgTable(
  "referrals",
  {
    id: id(),
    inviterId: uuid("inviter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    inviteeId: uuid("invitee_id").references(() => users.id, { onDelete: "cascade" }), // 注册即建关系
    code: text("code").notNull(), // 邀请码（绑邀请人）
    status: text("status").notNull().default("pending"), // pending/bound/frozen（frozen=风控冻结）
    rewardState: text("reward_state").notNull().default("pending"), // pending/unlocked/capped
    createdAt: createdAt(),
  },
  (t) => ({
    inviterIdx: index("referrals_inviter_idx").on(t.inviterId),
    inviteeUq: unique("referrals_invitee_uq").on(t.inviteeId),
  }),
)

// 单一权威键值配置表：运营注入数值，开发只读 + 种子写（不覆盖已改值）。
export const billingConfigs = pgTable("billing_configs", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: tz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
})
