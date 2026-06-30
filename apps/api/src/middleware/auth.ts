import { createMiddleware } from "hono/factory"
import { resolveUserFromToken } from "../services/auth"
import type { User } from "../db/schema"

export const authMiddleware = createMiddleware<{ Variables: { user: User } }>(async (c, next) => {
  const header = c.req.header("Authorization") ?? ""
  const token = header.startsWith("Bearer ") ? header.slice(7) : ""
  const user = token ? await resolveUserFromToken(token) : null
  if (!user) return c.json({ error: "unauthorized" }, 401)
  c.set("user", user)
  await next()
})
