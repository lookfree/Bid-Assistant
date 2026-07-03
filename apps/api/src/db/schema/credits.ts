import { pgTable, uuid, text, integer, index, unique } from "drizzle-orm/pg-core"
import { id, createdAt, tz } from "./columns"
import { users } from "./users"

// 只追加事件账本：余额 = Σ amount（credit_balances 仅缓存）。钱的权威在流水。
export const creditTransactions = pgTable(
  "credit_transactions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // grant(赠送) | purchase(充值) | hold(预扣) | settle(结算) | release(退还) |
    // expire(过期) | referral_reward(推荐奖励) | refund_clawback(退款注销已入账积分，负向)
    type: text("type").notNull(),
    amount: integer("amount").notNull(), // ± 积分（integer）
    sourceBatch: text("source_batch"), // 来源批次（FIFO 过期用）
    expireAt: tz("expire_at"), // 该笔过期时间（充值/赠送有别）
    ref: text("ref"), // 关联 agent_run / order / referral
    idempotencyKey: text("idempotency_key"), // 幂等键，防重复扣
    createdAt: createdAt(),
  },
  (t) => ({
    userIdx: index("credit_tx_user_idx").on(t.userId),
    idemUq: unique("credit_tx_idem_uq").on(t.idempotencyKey), // 幂等：同键只入一次
  }),
)

// 余额缓存（权威仍是 Σ流水；用于快速读 + 对账）。
export const creditBalances = pgTable("credit_balances", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  balance: integer("balance").notNull().default(0),
  updatedAt: tz("updated_at").notNull().defaultNow(),
})
