import { Hono } from "hono"
import { z } from "zod"
import { loginAdmin, logoutAdmin } from "../../services/admin-auth"
import { requireAdmin, bearer } from "../../middleware/admin-auth"
import { resolvePaymentDeps } from "../payment"
import type { RefundProvider } from "../../services/refunds"
import type { AdminUser } from "../../db/schema"
import { overviewRouter } from "./overview"
import { usersRouter } from "./users"
import { ordersRouter, refundsRouter } from "./orders"
import { ledgerRouter } from "./ledger"
import { plansRouter } from "./plans"
import { systemRouter } from "./system"
import { diffsRouter } from "./diffs"
import { modelsRouter } from "./models"
import { feedbackRouter } from "./feedback"
import { invoicesRouter } from "./invoices"

// admin-api 路由组（spec309/310）：与 C 端业务路由完全分组隔离，不复用 C 端 authMiddleware。
// 生产经反代按子域 admin.<域名> 路由到 apps/admin 前端。
const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) })

// 退款 provider 默认从 env 解析（测试可注入 mock）；无凭据环境 → 退款路由返 503。
const defaultResolveRefundProvider = (): RefundProvider | undefined => resolvePaymentDeps({}, "admin-refund")?.provider

export function adminRoutes(deps: { resolveRefundProvider?: () => RefundProvider | undefined } = {}) {
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

  // spec310 功能页：统一先过 requireAdmin（读=登录；写=各路由内 requirePermission）。
  // 挂在独立子 app 上，与上面的公开 /login 互不影响（/login 先注册，优先匹配）。
  const authed = new Hono<{ Variables: { admin: AdminUser } }>()
  authed.use("*", requireAdmin())
  authed.route("/overview", overviewRouter)
  authed.route("/users", usersRouter)
  authed.route("/orders", ordersRouter)
  authed.route("/refunds", refundsRouter(deps.resolveRefundProvider ?? defaultResolveRefundProvider))
  authed.route("/ledger", ledgerRouter)
  authed.route("/plans", plansRouter) // 含 /configs
  authed.route("/models", modelsRouter) // 模型库 + 编排链（spec319）
  authed.route("/diffs", diffsRouter) // 对账差异工作台
  authed.route("/feedback", feedbackRouter) // 反馈/投诉处理（spec326）
  authed.route("/invoices", invoicesRouter) // 发票管理：开具/驳回（spec332）
  authed.route("/", systemRouter) // /admins、/audit-logs
  r.route("/", authed)

  return r
}
