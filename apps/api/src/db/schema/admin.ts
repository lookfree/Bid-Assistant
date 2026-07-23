import { pgTable, uuid, text, jsonb, index, unique, check } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { id, tz, createdAt } from "./columns"

// 运营后台身份体系（spec309）：与 C 端 users/sessions **完全分离**——独立表、独立会话、独立子域。
// 枚举沿用码库约定（text + check + const 元组 $type），不用 pgEnum。

export const ADMIN_ROLES = ["superadmin", "ops", "finance", "support"] as const
export type AdminRole = (typeof ADMIN_ROLES)[number]
export const ADMIN_STATUSES = ["active", "disabled"] as const
export type AdminStatus = (typeof ADMIN_STATUSES)[number]

const roleInList = (col: unknown) => sql`${col} in ('superadmin','ops','finance','support')`

// 运营人员账号本体（与 C 端 users 无关）
export const adminUsers = pgTable(
  "admin_users",
  {
    id: id(),
    username: text("username").notNull().unique(),
    passwordHash: text("password_hash").notNull(), // Bun.password 哈希（非 native bcrypt）
    role: text("role").$type<AdminRole>().notNull().default("support"),
    status: text("status").$type<AdminStatus>().notNull().default("active"),
    createdAt: createdAt(),
  },
  (t) => ({
    roleCheck: check("admin_users_role_check", roleInList(t.role)),
    statusCheck: check("admin_users_status_check", sql`${t.status} in ('active','disabled')`),
  }),
)

// 角色 → 权限集（配置化载体；代码内默认映射在 rbac.ts，此表供 spec310 可视化/覆盖）
export const adminRoles = pgTable(
  "admin_roles",
  {
    role: text("role").$type<AdminRole>().primaryKey(),
    permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    roleCheck: check("admin_roles_role_check", roleInList(t.role)),
  }),
)

// admin 独立会话（与 C 端 sessions 分离；只存 token 的 sha256）
export const adminSessions = pgTable(
  "admin_sessions",
  {
    id: id(),
    adminId: uuid("admin_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: tz("expires_at").notNull(),
    revokedAt: tz("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => ({
    byAdmin: index("admin_sessions_admin_id_idx").on(t.adminId),
    tokenHashUq: unique("admin_sessions_token_hash_uq").on(t.tokenHash), // 一个 token hash 唯一标识一个会话
  }),
)

// 敏感操作审计（前后值留痕，供 spec310 所有写操作调用）
export const adminAuditLogs = pgTable(
  "admin_audit_logs",
  {
    id: id(),
    operator: text("operator").notNull(), // admin username（冗余存，便于追溯）
    action: text("action").notNull(), // 如 refund.approve / credit.adjust / user.ban
    target: text("target"), // 操作对象标识（order_id / user_id ...）
    before: jsonb("before"), // 操作前快照
    after: jsonb("after"), // 操作后快照
    createdAt: createdAt(),
  },
  (t) => ({
    byOperator: index("admin_audit_logs_operator_idx").on(t.operator),
    byAction: index("admin_audit_logs_action_idx").on(t.action),
    byCreated: index("admin_audit_logs_created_idx").on(t.createdAt.desc()), // spec331：默认按 created_at desc 分页
  }),
)

export type AdminUser = typeof adminUsers.$inferSelect
export type NewAdminUser = typeof adminUsers.$inferInsert
export type AdminSession = typeof adminSessions.$inferSelect
export type AdminAuditLog = typeof adminAuditLogs.$inferSelect
