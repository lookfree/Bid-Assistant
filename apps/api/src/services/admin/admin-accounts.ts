import { and, eq, gte, lte, sql, type SQL } from "drizzle-orm"
import { getDb } from "../../db/client"
import { adminUsers, adminAuditLogs, type AdminRole } from "../../db/schema"
import { writeAudit } from "../audit"
import { hashPassword } from "../admin-auth"
import { pagedResult } from "../../lib/pagination"

// 系统页服务（spec310）：运营账号/角色 CRUD + 审计日志查询（admin_users/admin_audit_logs，spec309 表）。
export async function listAdmins(opts: { page?: number; pageSize?: number }) {
  const db = getDb()
  const page = opts.page ?? 1
  const pageSize = opts.pageSize ?? 20
  return pagedResult(
    db
      .select({ id: adminUsers.id, username: adminUsers.username, role: adminUsers.role, status: adminUsers.status, createdAt: adminUsers.createdAt })
      .from(adminUsers)
      .orderBy(adminUsers.createdAt)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)` }).from(adminUsers),
  ) // 不返回 passwordHash
}

export async function createAdminAccount(input: { username: string; role: AdminRole; password: string }, opts: { operator: string }) {
  const passwordHash = await hashPassword(input.password)
  const [a] = await getDb().insert(adminUsers).values({ username: input.username, role: input.role, passwordHash, status: "active" }).returning()
  await writeAudit({ operator: opts.operator, action: "admin.manage", target: `admin:${a!.id}`, before: null, after: { username: a!.username, role: a!.role } })
  return { id: a!.id, username: a!.username, role: a!.role, status: a!.status }
}

export type AdminAccountErrorCode = "not_found" | "self_change" | "last_superadmin"
export class AdminAccountError extends Error {
  constructor(public code: AdminAccountErrorCode) {
    super(code)
  }
}

export async function updateAdminAccount(
  id: string,
  patch: { role?: AdminRole; status?: "active" | "disabled"; password?: string },
  opts: { operator: string },
) {
  const db = getDb()
  const [before] = await db.select().from(adminUsers).where(eq(adminUsers.id, id))
  if (!before) throw new AdminAccountError("not_found")
  // 防锁死：停用或从 superadmin 降级时——不能作用于操作者自己；不能停用/降级最后一个在用超管。
  const disabling = patch.status === "disabled"
  const demoting = patch.role !== undefined && patch.role !== "superadmin" && before.role === "superadmin"
  if (disabling || demoting) {
    if (before.username === opts.operator) throw new AdminAccountError("self_change")
    if (before.role === "superadmin") {
      const [row] = await db
        .select({ n: sql<number>`count(*)` })
        .from(adminUsers)
        .where(and(eq(adminUsers.role, "superadmin"), eq(adminUsers.status, "active")))
      if (Number(row?.n ?? 0) <= 1) throw new AdminAccountError("last_superadmin")
    }
  }
  // 改密走此处：明文只在服务端哈希入库，审计仅记 passwordReset 标记，绝不落明文/hash。
  const set: { role?: AdminRole; status?: "active" | "disabled"; passwordHash?: string } = {}
  if (patch.role !== undefined) set.role = patch.role
  if (patch.status !== undefined) set.status = patch.status
  if (patch.password !== undefined) set.passwordHash = await hashPassword(patch.password)
  // 空 patch：no-op 返回原值，避免 db.update().set({}) 抛「No values to set」500。
  if (Object.keys(set).length === 0) return { id: before.id, username: before.username, role: before.role, status: before.status }
  const [after] = await db.update(adminUsers).set(set).where(eq(adminUsers.id, id)).returning()
  await writeAudit({
    operator: opts.operator,
    action: "admin.manage",
    target: `admin:${id}`,
    before: { role: before.role, status: before.status },
    after: { role: after!.role, status: after!.status, ...(patch.password !== undefined ? { passwordReset: true } : {}) },
  })
  return { id: after!.id, username: after!.username, role: after!.role, status: after!.status }
}

export async function listAuditLogs(opts: { operator?: string; action?: string; from?: Date; to?: Date; page?: number; pageSize?: number }) {
  const db = getDb()
  const page = opts.page ?? 1
  const pageSize = opts.pageSize ?? 20
  const conds: SQL[] = []
  if (opts.operator) conds.push(eq(adminAuditLogs.operator, opts.operator))
  if (opts.action) conds.push(eq(adminAuditLogs.action, opts.action))
  if (opts.from) conds.push(gte(adminAuditLogs.createdAt, opts.from))
  if (opts.to) conds.push(lte(adminAuditLogs.createdAt, opts.to))
  const where = conds.length ? and(...conds) : undefined
  return pagedResult(
    db.select().from(adminAuditLogs).where(where).orderBy(sql`${adminAuditLogs.createdAt} desc`).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)` }).from(adminAuditLogs).where(where),
  )
}
