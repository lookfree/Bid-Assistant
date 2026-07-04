import { Hono } from "hono"
import { requirePermission } from "../../middleware/admin-auth"
import { parsePagination, pagedBody } from "../../lib/pagination"
import { listDiffs, resolveDiff, fixUnknownPaid } from "../../services/admin/diffs"
import type { AdminUser } from "../../db/schema"

// 对账差异工作台路由（spec310）：列表=登录；处置/修复=refund.write（对账属 finance，涉及补入账）。
export const diffsRouter = new Hono<{ Variables: { admin: AdminUser } }>()

diffsRouter.get("/", async (c) => {
  let pg
  try {
    pg = parsePagination(c.req.query())
  } catch {
    return c.json({ error: "invalid_pagination" }, 400)
  }
  const result = await listDiffs({ resolved: c.req.query("resolved") || undefined, diffType: c.req.query("diffType") || undefined, page: pg.page, pageSize: pg.pageSize })
  return c.json(pagedBody(pg, result))
})

diffsRouter.patch("/:id/resolve", requirePermission("refund.write"), async (c) => {
  try {
    return c.json(await resolveDiff(c.req.param("id"), { operator: c.var.admin.username }))
  } catch (e) {
    return c.json({ error: (e as Error).message }, 422)
  }
})

diffsRouter.post("/:id/fix-unknown-paid", requirePermission("refund.write"), async (c) => {
  try {
    return c.json(await fixUnknownPaid(c.req.param("id"), { operator: c.var.admin.username }))
  } catch (e) {
    return c.json({ error: (e as Error).message }, 422)
  }
})
