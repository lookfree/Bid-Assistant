import { createMiddleware } from "hono/factory"
import { resolveUserFromToken } from "../services/auth"
import type { User } from "../db/schema"

export const authMiddleware = createMiddleware<{ Variables: { user: User } }>(async (c, next) => {
  const header = c.req.header("Authorization") ?? ""
  const token = header.startsWith("Bearer ") ? header.slice(7) : ""
  const user = token ? await resolveUserFromToken(token) : null
  if (!user) return c.json({ error: "unauthorized" }, 401)
  // 封禁咽喉点：所有 C 端路由都挂本中间件，这里一拦=全线生效（会话不吊销——解封即恢复）。
  // 403 区别于 401：前端据 account_banned 展示封禁文案而非当作会话过期。
  if (user.status === "banned") return c.json({ error: "account_banned" }, 403)
  c.set("user", user)
  await next()
})
