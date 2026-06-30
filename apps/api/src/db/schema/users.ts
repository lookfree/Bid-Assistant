import { pgTable, uuid, text, timestamp, pgEnum } from "drizzle-orm/pg-core"

export const userStatus = pgEnum("user_status", ["active", "banned"])

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: userStatus("status").notNull().default("active"),
  nickname: text("nickname"),
  avatarUrl: text("avatar_url"),
  termsAgreedAt: timestamp("terms_agreed_at", { withTimezone: true }), // 注册即同意协议的时间（合规留痕）
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
