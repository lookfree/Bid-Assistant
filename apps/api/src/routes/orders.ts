import { Hono } from "hono"
import { ZodError } from "zod"
import type { User } from "../db/schema"
import { authMiddleware } from "../middleware/auth"
import { getUserId } from "../lib/auth-user"
import { parsePagination, pagedBody } from "../lib/pagination"
import { listOrders } from "../services/order-history"

// 我的订单路由（spec308，只读）：分页查当前用户订单。挂载于 /api/orders。
export function ordersRoutes() {
  const r = new Hono<{ Variables: { user: User } }>()
  r.use("*", authMiddleware)

  r.get("/", async (c) => {
    let pg
    try {
      pg = parsePagination(c.req.query())
    } catch (e) {
      if (e instanceof ZodError) return c.json({ error: "invalid_pagination" }, 400)
      throw e
    }
    return c.json(pagedBody(pg, await listOrders(getUserId(c), pg)))
  })

  return r
}
