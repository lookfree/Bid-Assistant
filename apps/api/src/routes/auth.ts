import { Hono } from "hono"
import { z } from "zod"
import { authMiddleware } from "../middleware/auth"
import { loginWithPhone, logout, TermsRequiredError, InvalidCodeError, AccountBannedError } from "../services/auth"
import { findUserByIdentity, getUserPhone } from "../repos/users"
import { maskPhone } from "../lib/user-display"
import { sha256Hex } from "../services/crypto"
import { normalizePhone } from "../util/phone"
import type { SmsCodeService } from "../services/sms-code"

const phoneRe = /^\+?\d{6,15}$/
const sendSchema = z.object({
  phone: z.string().regex(phoneRe),
  captchaToken: z.string().max(4096).optional(), // param 是 JSON 串几百字节，加上限防超大 body 滥用
})
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
    // 封禁账号不发验证码（评审二轮）：验证码是真金白银的短信费,verify 侧才拦会先烧一条码费
    const existing = await findUserByIdentity("phone", phone)
    if (existing?.status === "banned") return c.json({ error: "account_banned" }, 403)
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
    // R2：设备指纹由服务端从 UA+IP 派生（客户端无法省略以绕过风控）。
    // UA、IP 皆缺则不派生（否则全塌成 sha256("|") 同一常量 → 后续注册全被误判 duplicate_device 冻结）。
    const deviceHash = userAgent || ip ? sha256Hex(`${userAgent ?? ""}|${ip ?? ""}`) : undefined
    try {
      // 验证码消费在 loginWithPhone 内、协议判定之后 → terms_required 不会烧掉码。
      const { token, user, isNew } = await loginWithPhone(
        phone,
        { userAgent, ip, agreedToTerms: body.data.agreedToTerms, referralCode: body.data.referralCode, deviceHash },
        deps.sessionTtlDays,
        () => deps.smsCode.verify(phone, body.data.code),
      )
      // 带回打码手机号：否则手机号注册的用户（nickname 为空）在刷新页面之前，
      // 会员中心的「当前账号」只能显示"已登录"——正是这个功能要解决的场景。
      return c.json({ token, isNew, user: { id: user.id, nickname: user.nickname, phone: maskPhone(phone) } })
    } catch (e) {
      if (e instanceof TermsRequiredError) return c.json({ error: "terms_required" }, 400)
      // 三种原因分开回：前端据此给三句不同的话，不再一律说"已过期"
      if (e instanceof InvalidCodeError) {
        const code = { expired: "code_expired", too_many: "code_too_many_attempts", mismatch: "invalid_code" }[e.reason]
        return c.json({ error: code }, 401)
      }
      if (e instanceof AccountBannedError) return c.json({ error: "account_banned" }, 403)
      throw e
    }
  })

  // 带回打码手机号：会员中心要显示「当前登录的是哪个账号」（多号切换、代客操作时尤其要紧）。
  // 只回打码值——展示够用，回完整号码是白白多暴露一份。
  r.get("/me", authMiddleware, async (c) => {
    const u = c.get("user")
    return c.json({ id: u.id, nickname: u.nickname, status: u.status, phone: maskPhone(await getUserPhone(u.id)) || null })
  })

  // 注销不挂 authMiddleware（评审二轮 F12）：封禁用户也必须能吊销自己的会话——盗号封禁场景下
  // 403 挡注销会让攻击者的会话在解封瞬间原样复活。logout(token) 无会话即 no-op,匿名调用无害。
  r.post("/logout", async (c) => {
    const header = c.req.header("Authorization") ?? ""
    if (header.startsWith("Bearer ")) await logout(header.slice(7))
    return c.json({ ok: true })
  })

  return r
}
