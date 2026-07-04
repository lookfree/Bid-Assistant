import { Hono } from "hono"
import { z } from "zod"
import { loginAdmin, logoutAdmin } from "../../services/admin-auth"
import { requireAdmin, bearer } from "../../middleware/admin-auth"
import type { AdminUser } from "../../db/schema"

// admin-api 路由组（spec309）：与 C 端业务路由完全分组隔离，不复用 C 端 authMiddleware。
// 生产经反代按子域 admin.<域名> 路由到 apps/admin 前端。spec310 在此挂功能子路由。
const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) })

export function adminRoutes() {
  const r = new Hono<{ Variables: { admin: AdminUser } }>()

  // 公开：账号密码登录 → 独立 admin session token
  r.post("/login", async (c) => {
    const parsed = loginSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: "bad_request" }, 400)
    const result = await loginAdmin(parsed.data.username, parsed.data.password)
    if (!result) return c.json({ error: "invalid_credentials" }, 401)
    const { token, admin } = result
    return c.json({ token, admin: { id: admin.id, username: admin.username, role: admin.role } })
  })

  // 鉴权：登出（撤销当前 admin session）
  r.post("/logout", requireAdmin(), async (c) => {
    await logoutAdmin(bearer(c))
    return c.body(null, 204)
  })

  // 鉴权：当前 admin
  r.get("/me", requireAdmin(), (c) => {
    const a = c.var.admin
    return c.json({ admin: { id: a.id, username: a.username, role: a.role, status: a.status } })
  })

  return r
}
