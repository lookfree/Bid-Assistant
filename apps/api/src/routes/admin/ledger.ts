import { Hono } from "hono"
import { requirePermission } from "../../middleware/admin-auth"
import { parsePagination, pagedBody } from "../../lib/pagination"
import { listLedger, checkBalance } from "../../services/admin/ledger"
import { getUserById } from "../../repos/users"
import { isUuid } from "../../lib/uuid"

// 账本页（spec310;2026-08-02 读接线）：只读,ledger.read（finance/ops/support 默认都有,行为不变、开关变真）。
export const ledgerRouter = new Hono()
ledgerRouter.get("/", requirePermission("ledger.read"), async (c) => {
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
// 余额对账校验（spec331 加固）：入参存在性校验——查无此人 → 404,避免运营拿错 id（如把账本记录 id
// 当 userId 传）永远得到 consistent:true 的假"一致"结论。原契约（真实 userId → 对账结果）不变。
ledgerRouter.get("/:userId/check", requirePermission("ledger.read"), async (c) => {
  const userId = c.req.param("userId")
  if (!isUuid(userId) || !(await getUserById(userId))) return c.json({ error: "user_not_found" }, 404)
  return c.json(await checkBalance(userId))
})
