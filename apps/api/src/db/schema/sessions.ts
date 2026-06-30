import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core"
import { users } from "./users"

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    userAgent: text("user_agent"),
    ip: text("ip"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byUser: index("sessions_user_id_idx").on(t.userId),
    byTokenHash: index("sessions_token_hash_idx").on(t.tokenHash),
  }),
)

export type Session = typeof sessions.$inferSelect
export type NewSession = typeof sessions.$inferInsert
