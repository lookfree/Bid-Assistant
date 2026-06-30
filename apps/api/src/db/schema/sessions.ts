import { pgTable, uuid, text, index, unique } from "drizzle-orm/pg-core"
import { id, tz, createdAt } from "./columns"
import { users } from "./users"

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    userAgent: text("user_agent"),
    ip: text("ip"),
    expiresAt: tz("expires_at").notNull(),
    revokedAt: tz("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => ({
    byUser: index("sessions_user_id_idx").on(t.userId),
    // token_hash 唯一标识一个会话；用 UNIQUE 由库强制（兼作查询索引），不靠概率。
    tokenHashUq: unique("sessions_token_hash_uq").on(t.tokenHash),
  }),
)

export type Session = typeof sessions.$inferSelect
