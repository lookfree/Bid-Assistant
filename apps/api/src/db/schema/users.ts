import { pgTable, text, pgEnum } from "drizzle-orm/pg-core"
import { id, tz, createdAt } from "./columns"

export const userStatus = pgEnum("user_status", ["active", "banned"])

export const users = pgTable("users", {
  id: id(),
  status: userStatus("status").notNull().default("active"),
  nickname: text("nickname"),
  avatarUrl: text("avatar_url"),
  termsAgreedAt: tz("terms_agreed_at"), // 注册即同意协议的时间（合规留痕）
  createdAt: createdAt(),
  // $onUpdate 只对经 Drizzle 的写入生效；裸 SQL/外部直写不会刷新 updated_at（届时需加 DB 触发器）。
  updatedAt: tz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
})

export type User = typeof users.$inferSelect
