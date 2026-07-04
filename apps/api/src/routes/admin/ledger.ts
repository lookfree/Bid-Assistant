import { Hono } from "hono"
import { parsePagination, pagedBody } from "../../lib/pagination"
import { listLedger, checkBalance } from "../../services/admin/ledger"

// 账本页（spec310）：只读，登录即可。
export const ledgerRouter = new Hono()
ledgerRouter.get("/", async (c) => {
  const userId = c.req.query("userId")
  if (!userId) return c.json({ error: "userId 必填" }, 400)
  let pg
  try {
    pg = parsePagination(c.req.query())
  } catch {
    return c.json({ error: "invalid_pagination" }, 400)
  }
  return c.json(pagedBody(pg, await listLedger({ userId, type: c.req.query("type") || undefined, page: pg.page, pageSize: pg.pageSize })))
})
ledgerRouter.get("/:userId/check", async (c) => c.json(await checkBalance(c.req.param("userId"))))
