import { pgTable, uuid, text, jsonb, index, check } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { id, tz, createdAt } from "./columns"
import { users } from "./users"

// 资料库分类：与前端原型六分类一一对应（枚举沿用码库约定：text + check + const 元组 $type，不用 pgEnum）
export const LIBRARY_CATEGORIES = ["qualification", "performance", "personnel", "finance", "text", "presentation"] as const
export type LibraryCategory = (typeof LIBRARY_CATEGORIES)[number]

// 个人资料库条目：投标常用素材（资质/业绩/人员/财务/文本/演示），按用户隔离。
export const libraryItems = pgTable(
  "library_items",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    category: text("category").$type<LibraryCategory>().notNull(),
    title: text("title").notNull(),
    meta: text("meta"), // 一句话摘要（证书编号/合同金额等）
    fields: jsonb("fields").$type<{ label: string; value: string }[]>(), // 结构化字段
    expiry: text("expiry"), // 有效期（ISO 日期或可读文本，如「长期有效」）
    tags: jsonb("tags").$type<string[]>(),
    attachments: jsonb("attachments").$type<{ fileId: string; name: string }[]>(), // 关联 project_files 已上传文件
    body: text("body"), // 正文（text 类素材的常用段落）
    createdAt: createdAt(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("library_items_user_idx").on(t.userId),
    categoryCheck: check(
      "library_items_category_check",
      sql`${t.category} in ('qualification','performance','personnel','finance','text','presentation')`,
    ),
  }),
)

export type LibraryItem = typeof libraryItems.$inferSelect
