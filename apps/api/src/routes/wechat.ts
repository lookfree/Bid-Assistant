import { Hono } from "hono"
import { z } from "zod"
import { TermsRequiredError } from "../services/auth"
import { clientIp } from "./auth"
import { InvalidStateError, makeWechatAuth } from "../services/wechat-auth"

export type WechatRouteDeps = {
  wechat: ReturnType<typeof makeWechatAuth>
  appId: string
  redirectUri: string
}

export function wechatRoutes(deps: WechatRouteDeps) {
  const r = new Hono()

  // 建二维码所需参数：落 state（含协议同意位）+ 回传网站应用参数（appId/scope/redirectUri）。
  r.post("/url", async (c) => {
    const body = z
      .object({ agreedToTerms: z.boolean().optional() })
      .safeParse(await c.req.json().catch(() => ({})))
    const state = await deps.wechat.createState(body.success ? !!body.data.agreedToTerms : false)
    return c.json({ state, appId: deps.appId, scope: "snsapi_login", redirectUri: deps.redirectUri })
  })

  // 回调换登录：code+state → 令牌；state 无效 400、新号未同意协议 400、其余失败 401。
  r.post("/login", async (c) => {
    const body = z
      .object({ code: z.string().min(1), state: z.string().min(1) })
      .safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid_input" }, 400)
    try {
      const { token, user, isNew } = await deps.wechat.login(body.data.code, body.data.state, {
        userAgent: c.req.header("User-Agent"),
        ip: clientIp((n) => c.req.header(n)),
      })
      return c.json({ token, isNew, user: { id: user.id, nickname: user.nickname } })
    } catch (e) {
      if (e instanceof TermsRequiredError) return c.json({ error: "terms_required" }, 400)
      if (e instanceof InvalidStateError) return c.json({ error: "invalid_state" }, 400)
      return c.json({ error: "wechat_login_failed" }, 401)
    }
  })

  return r
}
