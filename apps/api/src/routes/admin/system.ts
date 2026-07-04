import { Hono } from "hono"
import { z } from "zod"
import { requirePermission } from "../../middleware/admin-auth"
import { parsePagination, pagedBody } from "../../lib/pagination"
import { listAdmins, createAdminAccount, updateAdminAccount, listAuditLogs } from "../../services/admin/admin-accounts"
import type { AdminUser } from "../../db/schema"

// 系统页（spec310）：运营账号管理=admin.manage（仅 superadmin）；审计日志查询=audit.read。
export const systemRouter = new Hono<{ Variables: { admin: AdminUser } }>()

systemRouter.get("/admins", requirePermission("admin.manage"), async (c) => {
  let pg
  try {
    pg = parsePagination(c.req.query())
  } catch {
    return c.json({ error: "invalid_pagination" }, 400)
  }
  return c.json(pagedBody(pg, await listAdmins({ page: pg.page, pageSize: pg.pageSize })))
})
const CreateBody = z.object({ username: z.string().min(1), role: z.enum(["superadmin", "ops", "finance", "support"]), password: z.string().min(8) })
systemRouter.post("/admins", requirePermission("admin.manage"), async (c) => {
  const parsed = CreateBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
  return c.json(await createAdminAccount(parsed.data, { operator: c.var.admin.username }))
})
const UpdateBody = z.object({ role: z.enum(["superadmin", "ops", "finance", "support"]).optional(), status: z.enum(["active", "disabled"]).optional() })
systemRouter.put("/admins/:id", requirePermission("admin.manage"), async (c) => {
  const parsed = UpdateBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
  return c.json(await updateAdminAccount(c.req.param("id"), parsed.data, { operator: c.var.admin.username }))
})

systemRouter.get("/audit-logs", requirePermission("audit.read"), async (c) => {
  let pg
  try {
    pg = parsePagination(c.req.query())
  } catch {
    return c.json({ error: "invalid_pagination" }, 400)
  }
  const from = c.req.query("from") ? new Date(c.req.query("from")!) : undefined
  const to = c.req.query("to") ? new Date(c.req.query("to")!) : undefined
  const result = await listAuditLogs({
    operator: c.req.query("operator") || undefined,
    action: c.req.query("action") || undefined,
    from,
    to,
    page: pg.page,
    pageSize: pg.pageSize,
  })
  return c.json(pagedBody(pg, result))
})
