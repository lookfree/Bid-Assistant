import { Hono } from "hono"
import { z } from "zod"
import { TermsRequiredError, AccountBannedError, InvalidCodeError } from "../services/auth"
import { clientIp } from "./auth"
import { InvalidStateError, PhoneTakenError, makeWechatAuth } from "../services/wechat-auth"
import { normalizePhone } from "../util/phone"
import { maskPhone } from "../lib/user-display"
import { getUserPhone } from "../repos/users"
import type { SmsCodeService } from "../services/sms-code"

export type WechatRouteDeps = {
  wechat: ReturnType<typeof makeWechatAuth>
  appId: string
  redirectUri: string
  smsCode: SmsCodeService // 微信登录必须绑手机号 → 短信服务是硬依赖
}

const bindSchema = z.object({
  bindToken: z.string().min(1).max(128),
  phone: z.string().regex(/^\+?\d{6,15}$/),
  code: z.string().regex(/^\d{6}$/),
})

// 各类失败 → HTTP 码的单一翻译点（login 与 bind-phone 共用）。
function errorResponse(e: unknown): { body: { error: string }; status: 400 | 401 | 403 } {
  if (e instanceof TermsRequiredError) return { body: { error: "terms_required" }, status: 400 }
  if (e instanceof InvalidStateError) return { body: { error: "invalid_state" }, status: 400 }
  if (e instanceof PhoneTakenError) return { body: { error: "phone_taken" }, status: 400 }
  if (e instanceof AccountBannedError) return { body: { error: "account_banned" }, status: 403 } // 须在兜底 401 之前
  if (e instanceof InvalidCodeError) {
    const code = { expired: "code_expired", too_many: "code_too_many_attempts", mismatch: "invalid_code" }[e.reason]
    return { body: { error: code }, status: 401 }
  }
  return { body: { error: "wechat_login_failed" }, status: 401 }
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

  // 回调换登录：code+state → 已绑手机号的老账号发令牌；否则回一次性绑定态（前端接着要手机号）。
  r.post("/login", async (c) => {
    const body = z
      .object({ code: z.string().min(1), state: z.string().min(1) })
      .safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid_input" }, 400)
    try {
      const res = await deps.wechat.login(body.data.code, body.data.state, {
        userAgent: c.req.header("User-Agent"),
        ip: clientIp((n) => c.req.header(n)),
      })
      if (res.needBindPhone) return c.json({ needBindPhone: true, bindToken: res.bindToken })
      // 老账号必然已绑手机号（否则不会走到这），带回打码值供前端显示「当前账号」
      return c.json({ token: res.token, isNew: res.isNew, user: await publicUser(res.user) })
    } catch (e) {
      const { body: err, status } = errorResponse(e)
      return c.json(err, status)
    }
  })

  // 绑手机号完成登录：短信验证码即所有权证明。手机号已有账号 → 挂靠它，不建新号。
  r.post("/bind-phone", async (c) => {
    const body = bindSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid_input" }, 400)
    const phone = normalizePhone(body.data.phone)
    try {
      const { token, user, isNew } = await deps.wechat.bindPhone(
        body.data.bindToken,
        phone,
        { userAgent: c.req.header("User-Agent"), ip: clientIp((n) => c.req.header(n)) },
        () => deps.smsCode.verify(phone, body.data.code),
      )
      return c.json({ token, isNew, user: { id: user.id, nickname: user.nickname, phone: maskPhone(phone) } })
    } catch (e) {
      const { body: err, status } = errorResponse(e)
      return c.json(err, status)
    }
  })

  return r
}

async function publicUser(user: { id: string; nickname: string | null }) {
  return { id: user.id, nickname: user.nickname, phone: maskPhone(await getUserPhone(user.id)) || null }
}
