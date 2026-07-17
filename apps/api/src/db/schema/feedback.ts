import { pgTable, uuid, text, index, check } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { id, tz, createdAt } from "./columns"
import { users } from "./users"
import { bidProjects } from "./bid-projects"

// 用户反馈/投诉（spec326）：算法备案要求「投诉/申诉入口且处理可追溯」。
// money-blind：/api/feedback 免费，不与积分账本发生任何交互。
export const FEEDBACK_TYPES = ["content_error", "complaint", "billing", "suggestion", "other"] as const
export type FeedbackType = (typeof FEEDBACK_TYPES)[number]
export const FEEDBACK_STATUSES = ["pending", "processing", "resolved"] as const
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number]

export const feedback = pgTable(
  "feedback",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<FeedbackType>().notNull(),
    // 可空：反馈可能与具体项目无关（如通用建议）；项目被删不应删掉反馈记录，只置空关联。
    projectId: uuid("project_id").references(() => bidProjects.id, { onDelete: "set null" }),
    content: text("content").notNull(),
    contact: text("contact"),
    status: text("status").$type<FeedbackStatus>().notNull().default("pending"),
    reply: text("reply"),
    handledBy: text("handled_by"), // admin username（与审计 operator 口径一致，不做 FK）
    handledAt: tz("handled_at"),
    createdAt: createdAt(),
  },
  (t) => ({
    statusIdx: index("feedback_status_idx").on(t.status, t.createdAt),
    userIdx: index("feedback_user_idx").on(t.userId, t.createdAt),
    typeCheck: check("feedback_type_check", sql`${t.type} in ('content_error','complaint','billing','suggestion','other')`),
    statusCheck: check("feedback_status_check", sql`${t.status} in ('pending','processing','resolved')`),
  }),
)

export type Feedback = typeof feedback.$inferSelect
