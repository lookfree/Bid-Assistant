import { Hono } from "hono"
import type { User } from "../db/schema"
import { authMiddleware } from "../middleware/auth"
import { getMyCode, listReferrals } from "../services/referral"

// 推荐路由（spec307）：我的邀请码 + 邀请列表。均需登录（沿用 authMiddleware，从会话取当前用户）。
export function referralRoutes() {
  const r = new Hono<{ Variables: { user: User } }>()
  r.use("*", authMiddleware)

  r.get("/code", async (c) => {
    const code = await getMyCode(c.get("user").id)
    return c.json({ code })
  })

  r.get("/list", async (c) => {
    const list = await listReferrals(c.get("user").id)
    return c.json({ list })
  })

  return r
}
