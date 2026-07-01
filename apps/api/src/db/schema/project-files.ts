import { pgTable, uuid, text, bigint, pgEnum, index } from "drizzle-orm/pg-core"
import { id, createdAt } from "./columns"
import { users } from "./users"

export const fileStatus = pgEnum("file_status", ["pending", "uploaded"])

export const projectFiles = pgTable(
  "project_files",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id"), // 项目状态机 Phase 2，先留空
    bucket: text("bucket").notNull(),
    key: text("key").notNull().unique(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    status: fileStatus("status").notNull().default("pending"),
    etag: text("etag"),
    createdAt: createdAt(),
  },
  (t) => ({ byUser: index("project_files_user_id_idx").on(t.userId) }),
)

export type ProjectFile = typeof projectFiles.$inferSelect
