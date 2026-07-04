import { Hono } from "hono"
import { z } from "zod"
import { authMiddleware } from "../middleware/auth"
import { loginWithPhone, logout, TermsRequiredError, InvalidCodeError } from "../services/auth"
import { sha256Hex } from "../services/crypto"
import { normalizePhone } from "../util/phone"
import type { SmsCodeService } from "../services/sms-code"

const phoneRe = /^\+?\d{6,15}$/
const sendSchema = z.object({ phone: z.string().regex(phoneRe), captchaToken: z.string().optional() })
const verifySchema = z.object({
  phone: z.string().regex(phoneRe),
  code: z.string().regex(/^\d{6}$/),
  agreedToTerms: z.boolean().optional(), // 首次注册必须为 true
  referralCode: z.string().min(1).max(16).optional(), // 首次注册带邀请码 → 绑定推荐关系（spec307 引擎入口，R1）
})

export type AuthRouteDeps = {
  smsCode: SmsCodeService
  sessionTtlDays: number
  captchaEnabled: boolean
  verifyCaptcha: (token?: string) => Promise<boolean>
}

// 注：X-Forwarded-For 由客户端可伪造，生产应配可信代理感知取 IP（见 docs/review-followups.md #6）。
export const clientIp = (h: (name: string) => string | undefined): string | undefined =>
  h("X-Forwarded-For")?.split(",")[0]?.trim() || h("X-Real-IP")

export function authRoutes(deps: AuthRouteDeps) {
  const r = new Hono()

  r.post("/sms/send", async (c) => {
    const body = sendSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid_phone" }, 400)
    if (deps.captchaEnabled && !(await deps.verifyCaptcha(body.data.captchaToken))) {
      return c.json({ error: "captcha_required" }, 403)
    }
    const phone = normalizePhone(body.data.phone)
    const ip = clientIp((n) => c.req.header(n))
    const res = await deps.smsCode.request({ phone, ip })
    if (!res.ok) {
      return c.json({ error: "too_many_requests", reason: res.reason, retryAfter: res.retryAfter }, 429)
    }
    return c.json({ ok: true })
  })

  r.post("/sms/verify", async (c) => {
    const body = verifySchema.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid_input" }, 400)
    const phone = normalizePhone(body.data.phone)
    const ip = clientIp((n) => c.req.header(n))
    const userAgent = c.req.header("User-Agent")
    // R2：设备指纹由服务端从 UA+IP 派生（客户端无法省略以绕过风控）；缺 UA/IP 本身即弱指纹。
    const deviceHash = sha256Hex(`${userAgent ?? ""}|${ip ?? ""}`)
    try {
      // 验证码消费在 loginWithPhone 内、协议判定之后 → terms_required 不会烧掉码。
      const { token, user, isNew } = await loginWithPhone(
        phone,
        { userAgent, ip, agreedToTerms: body.data.agreedToTerms, referralCode: body.data.referralCode, deviceHash },
        deps.sessionTtlDays,
        () => deps.smsCode.verify(phone, body.data.code),
      )
      return c.json({ token, isNew, user: { id: user.id, nickname: user.nickname } })
    } catch (e) {
      if (e instanceof TermsRequiredError) return c.json({ error: "terms_required" }, 400)
      if (e instanceof InvalidCodeError) return c.json({ error: "invalid_code" }, 401)
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
