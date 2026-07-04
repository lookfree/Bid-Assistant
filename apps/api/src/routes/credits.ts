import { Hono } from "hono"
import { ZodError } from "zod"
import type { User } from "../db/schema"
import { authMiddleware } from "../middleware/auth"
import { getUserId } from "../lib/auth-user"
import { parsePagination, pagedBody } from "../lib/pagination"
import { listCreditTransactions } from "../services/credits-history"

// 积分流水路由（spec308，只读）：分页查当前用户流水。挂载于 /api/credits。
export function creditsRoutes() {
  const r = new Hono<{ Variables: { user: User } }>()
  r.use("*", authMiddleware)

  r.get("/transactions", async (c) => {
    let pg
    try {
      pg = parsePagination(c.req.query())
    } catch (e) {
      if (e instanceof ZodError) return c.json({ error: "invalid_pagination" }, 400)
      throw e
    }
    return c.json(pagedBody(pg, await listCreditTransactions(getUserId(c), pg)))
  })

  return r
}
