import { and, eq, gte, lte, sql, type SQL } from "drizzle-orm"
import { getDb } from "../../db/client"
import { adminUsers, adminAuditLogs, type AdminRole } from "../../db/schema"
import { writeAudit } from "../audit"
import { hashPassword } from "../admin-auth"

// 系统页服务（spec310）：运营账号/角色 CRUD + 审计日志查询（admin_users/admin_audit_logs，spec309 表）。
export async function listAdmins(opts: { page?: number; pageSize?: number }) {
  const db = getDb()
  const page = opts.page ?? 1
  const pageSize = opts.pageSize ?? 20
  const [items, [cnt]] = await Promise.all([
    db
      .select({ id: adminUsers.id, username: adminUsers.username, role: adminUsers.role, status: adminUsers.status, createdAt: adminUsers.createdAt })
      .from(adminUsers)
      .orderBy(adminUsers.createdAt)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)` }).from(adminUsers),
  ])
  return { items, total: Number(cnt!.n), page, pageSize } // 不返回 passwordHash
}

export async function createAdminAccount(input: { username: string; role: AdminRole; password: string }, opts: { operator: string }) {
  const passwordHash = await hashPassword(input.password)
  const [a] = await getDb().insert(adminUsers).values({ username: input.username, role: input.role, passwordHash, status: "active" }).returning()
  await writeAudit({ operator: opts.operator, action: "admin.manage", target: `admin:${a!.id}`, before: null, after: { username: a!.username, role: a!.role } })
  return { id: a!.id, username: a!.username, role: a!.role, status: a!.status }
}

export async function updateAdminAccount(id: string, patch: { role?: AdminRole; status?: "active" | "disabled" }, opts: { operator: string }) {
  const db = getDb()
  const [before] = await db.select().from(adminUsers).where(eq(adminUsers.id, id))
  if (!before) throw new Error("运营账号不存在")
  const [after] = await db.update(adminUsers).set(patch).where(eq(adminUsers.id, id)).returning()
  await writeAudit({
    operator: opts.operator,
    action: "admin.manage",
    target: `admin:${id}`,
    before: { role: before.role, status: before.status },
    after: { role: after!.role, status: after!.status },
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
  const [items, [cnt]] = await Promise.all([
    db.select().from(adminAuditLogs).where(where).orderBy(sql`${adminAuditLogs.createdAt} desc`).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)` }).from(adminAuditLogs).where(where),
  ])
  return { items, total: Number(cnt!.n), page, pageSize }
}
