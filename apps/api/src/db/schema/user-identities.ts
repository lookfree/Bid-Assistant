import { pgTable, uuid, text, timestamp, pgEnum, unique, index } from "drizzle-orm/pg-core"
import { users } from "./users"

export const identityProvider = pgEnum("identity_provider", ["phone", "wechat", "alipay"])
export type IdentityProvider = (typeof identityProvider.enumValues)[number]

export const userIdentities = pgTable(
  "user_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: identityProvider("provider").notNull(),
    identifier: text("identifier").notNull(),
    credential: text("credential"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: unique("user_identities_provider_identifier_uq").on(t.provider, t.identifier),
    byUser: index("user_identities_user_id_idx").on(t.userId),
  }),
)

export type UserIdentity = typeof userIdentities.$inferSelect
export type NewUserIdentity = typeof userIdentities.$inferInsert
