import { Hono } from "hono"
import { getConfig, pickNonNegative } from "../services/config"

// 公开（免鉴权）展示配置：C 端首页/落地页等未登录页用。只出可公开的展示值，绝不含密钥/内部计费口径。
export function publicRoutes() {
  const r = new Hono()
  // 注册赠送积分（运营后台 signup_grant_credits，实时）：前端展示读此值，避免写死与后台漂移。
  r.get("/config", async (c) => {
    const signupGrantCredits = pickNonNegative(await getConfig("signup_grant_credits"), 200)
    return c.json({ signupGrantCredits })
  })
  return r
}
