import { createMiddleware } from "hono/factory"
import { resolveAdminFromToken } from "../services/admin-auth"
import { hasPermission, type Permission } from "../services/rbac"
import type { AdminUser, AdminRole } from "../db/schema"

// RBAC 中间件（spec309）：解析 admin session → 注入 c.var.admin → 校验角色/权限。
// 未认证 401，越权 403，语义区分。绝不查 C 端 sessions。
type AdminVars = { Variables: { admin: AdminUser } }

function bearer(c: { req: { header: (k: string) => string | undefined } }): string {
  const h = c.req.header("Authorization") ?? ""
  return h.startsWith("Bearer ") ? h.slice(7) : ""
}

// 解析 admin session → 注入 c.var.admin → 校验角色白名单（roles 空＝任意已认证 admin）。
export function requireAdmin(...roles: AdminRole[]) {
  return createMiddleware<AdminVars>(async (c, next) => {
    const token = bearer(c)
    const admin = token ? await resolveAdminFromToken(token) : null
    if (!admin) return c.json({ error: "unauthorized" }, 401)
    if (roles.length > 0 && !roles.includes(admin.role)) return c.json({ error: "forbidden" }, 403)
    c.set("admin", admin)
    await next()
  })
}

// 在已认证基础上按「角色→权限」校验细粒度权限。
export function requirePermission(perm: Permission) {
  return createMiddleware<AdminVars>(async (c, next) => {
    const token = bearer(c)
    const admin = token ? await resolveAdminFromToken(token) : null
    if (!admin) return c.json({ error: "unauthorized" }, 401)
    if (!hasPermission(admin.role, perm)) return c.json({ error: "forbidden" }, 403)
    c.set("admin", admin)
    await next()
  })
}
