import { Hono } from "hono"
import { z } from "zod"
import { requirePermission } from "../../middleware/admin-auth"
import { parsePagination, pagedBody } from "../../lib/pagination"
import { listUsers, getUserDetail, banUser, unbanUser, adminGrantCredits } from "../../services/admin/admin-users"
import type { AdminUser } from "../../db/schema"

// 用户页（spec310）：读=登录；封禁/解封=user.write；调积分=credit.adjust。
export const usersRouter = new Hono<{ Variables: { admin: AdminUser } }>()

usersRouter.get("/", async (c) => {
  let pg
  try {
    pg = parsePagination(c.req.query())
  } catch {
    return c.json({ error: "invalid_pagination" }, 400)
  }
  return c.json(pagedBody(pg, await listUsers({ q: c.req.query("q") || undefined, page: pg.page, pageSize: pg.pageSize })))
})
usersRouter.get("/:id", async (c) => c.json(await getUserDetail(c.req.param("id"))))

usersRouter.post("/:id/ban", requirePermission("user.write"), async (c) => {
  await banUser(c.req.param("id"), { operator: c.var.admin.username })
  return c.json({ ok: true })
})
usersRouter.post("/:id/unban", requirePermission("user.write"), async (c) => {
  await unbanUser(c.req.param("id"), { operator: c.var.admin.username })
  return c.json({ ok: true })
})

// idempotencyKey 前端每次调整弹窗生成一个 UUID：双击/重试同键 → 只入账一次（防重复给钱/扣钱）。
const GrantBody = z.object({ amount: z.number().int(), reason: z.string().min(1), idempotencyKey: z.string().min(1) })
usersRouter.post("/:id/credits", requirePermission("credit.adjust"), async (c) => {
  const parsed = GrantBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
  try {
    return c.json(await adminGrantCredits(c.req.param("id"), { ...parsed.data, operator: c.var.admin.username }))
  } catch (e) {
    return c.json({ error: (e as Error).message }, 422) // 如扣穿余额
  }
})
