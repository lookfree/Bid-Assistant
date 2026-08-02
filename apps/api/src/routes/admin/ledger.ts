import { Hono } from "hono"
import { requirePermission } from "../../middleware/admin-auth"
import { parsePagination, pagedBody } from "../../lib/pagination"
import { listLedger, checkBalance } from "../../services/admin/ledger"
import { listUsers } from "../../services/admin/admin-users"
import { getUserById } from "../../repos/users"
import { isUuid } from "../../lib/uuid"

// 账本页（spec310;2026-08-02 读接线）：只读,ledger.read（finance/ops/support 默认都有,行为不变、开关变真）。
export const ledgerRouter = new Hono()

// 用户选择器（QA:财务有 ledger.read 无 user.read,账本页借全量用户接口做选择器被 403,整页不可用）：
// 账本审计必须能定位用户,但不需要完整用户信息——本接口仅回 id + 展示名(昵称,否则打码手机号),
// 权限随本页(ledger.read),用户明细/管理仍归 user.read。
ledgerRouter.get("/user-options", requirePermission("ledger.read"), async (c) => {
  const res = await listUsers({ page: 1, pageSize: 200 })
  const mask = (p?: string | null) => (p && p.length >= 7 ? `${p.slice(0, 3)}****${p.slice(-4)}` : (p ?? ""))
  const items = res.items.map((u: { id: string; nickname?: string | null; phone?: string | null }) => ({
    id: u.id,
    name: u.nickname || mask(u.phone) || u.id,
  }))
  return c.json({ items })
})
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
