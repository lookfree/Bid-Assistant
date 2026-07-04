import { Hono } from "hono"
import { listLedger, checkBalance } from "../../services/admin/ledger"

// 账本页（spec310）：只读，登录即可。
export const ledgerRouter = new Hono()
ledgerRouter.get("/", async (c) => {
  const userId = c.req.query("userId")
  if (!userId) return c.json({ error: "userId 必填" }, 400)
  return c.json(
    await listLedger({
      userId,
      type: c.req.query("type") || undefined,
      page: Number(c.req.query("page") ?? 1),
      pageSize: Number(c.req.query("pageSize") ?? 20),
    }),
  )
})
ledgerRouter.get("/:userId/check", async (c) => c.json(await checkBalance(c.req.param("userId"))))
