import { pgTable, uuid, jsonb, unique } from "drizzle-orm/pg-core"
import { id, tz, createdAt } from "./columns"
import { users } from "./users"
import { bidProjects } from "./bid-projects"

// 终极审核表状态项：pass 通过 / risk 风险 / pending 待核（与前端 risk 页三态一致）
export const CHECKLIST_STATUSES = ["pass", "risk", "pending"] as const
export type ChecklistStatus = (typeof CHECKLIST_STATUSES)[number]
export type ChecklistItem = { status: ChecklistStatus; owner?: string; note?: string }

// 终极审核表持久化（spec315b）：userId + 可空 projectId（无项目 = 独立工具的用户级默认行）。
// items = {"<组id-序号>": {status, owner, note}}。
// 唯一约束 (user_id, project_id) NULLS NOT DISTINCT（PG 16）：projectId 为空的默认行也只有一行，
// upsert 的 ON CONFLICT 才能命中；迁移 0025 手写对应 DDL。
export const projectChecklists = pgTable(
  "project_checklists",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => bidProjects.id, { onDelete: "cascade" }), // nullable
    items: jsonb("items").$type<Record<string, ChecklistItem>>().notNull().default({}),
    createdAt: createdAt(),
    // $onUpdate 只对经 Drizzle 的写入生效；upsert 的 DO UPDATE 分支在路由里显式 set updatedAt
    updatedAt: tz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    userProjectUq: unique("project_checklists_user_project_uq").on(t.userId, t.projectId).nullsNotDistinct(),
  }),
)
