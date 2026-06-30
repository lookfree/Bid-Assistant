import { Hono } from "hono"
import { z } from "zod"
import { authMiddleware } from "../middleware/auth"
import { loginWithPhone, logout, TermsRequiredError } from "../services/auth"
import type { SmsCodeService } from "../services/sms-code"

const phoneRe = /^\+?\d{6,15}$/
const sendSchema = z.object({ phone: z.string().regex(phoneRe), captchaToken: z.string().optional() })
const verifySchema = z.object({
  phone: z.string().regex(phoneRe),
  code: z.string().regex(/^\d{6}$/),
  agreedToTerms: z.boolean().optional(), // 首次注册必须为 true
})

export type AuthRouteDeps = {
  smsCode: SmsCodeService
  sessionTtlDays: number
  captchaEnabled: boolean
  verifyCaptcha: (token?: string) => Promise<boolean>
}

const clientIp = (h: (name: string) => string | undefined): string | undefined =>
  h("X-Forwarded-For")?.split(",")[0]?.trim() || h("X-Real-IP")

export function authRoutes(deps: AuthRouteDeps) {
  const r = new Hono()

  r.post("/sms/send", async (c) => {
    const body = sendSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid_phone" }, 400)
    if (deps.captchaEnabled && !(await deps.verifyCaptcha(body.data.captchaToken))) {
      return c.json({ error: "captcha_required" }, 403)
    }
    const ip = clientIp((n) => c.req.header(n))
    const res = await deps.smsCode.request({ phone: body.data.phone, ip })
    if (!res.ok) {
      return c.json({ error: "too_many_requests", reason: res.reason, retryAfter: res.retryAfter }, 429)
    }
    return c.json({ ok: true })
  })

  r.post("/sms/verify", async (c) => {
    const body = verifySchema.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid_input" }, 400)
    const ok = await deps.smsCode.verify(body.data.phone, body.data.code)
    if (!ok) return c.json({ error: "invalid_code" }, 401)
    const ip = clientIp((n) => c.req.header(n))
    try {
      const { token, user, isNew } = await loginWithPhone(
        body.data.phone,
        { userAgent: c.req.header("User-Agent"), ip, agreedToTerms: body.data.agreedToTerms },
        deps.sessionTtlDays,
      )
      return c.json({ token, isNew, user: { id: user.id, nickname: user.nickname } })
    } catch (e) {
      if (e instanceof TermsRequiredError) return c.json({ error: "terms_required" }, 400)
      throw e
    }
  })

  r.get("/me", authMiddleware, (c) => {
    const u = c.get("user")
    return c.json({ id: u.id, nickname: u.nickname, status: u.status })
  })

  r.post("/logout", authMiddleware, async (c) => {
    const header = c.req.header("Authorization") ?? ""
    await logout(header.slice(7))
    return c.json({ ok: true })
  })

  return r
}
