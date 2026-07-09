import { describe, it, expect, afterAll, setDefaultTimeout } from "bun:test"
import { createApp } from "../../src/app"
import type { SmsCodeService } from "../../src/services/sms-code"
import { findUserByIdentity } from "../../src/repos/users"
import { getDb } from "../../src/db/client"
import { users } from "../../src/db/schema"
import { eq } from "drizzle-orm"

setDefaultTimeout(20000) // 连远程 DB

const phone = `+8613${Date.now().toString().slice(-9)}`
const freshPhone = `+8613${(Date.now() + 7).toString().slice(-9)}` // 用于 terms_required（不建号）
const FIXED = "123456"

// 假验证码服务：固定码 123456，便于路由测试不依赖 Redis
const fakeSms: SmsCodeService = {
  async request() {
    return { ok: true }
  },
  async verify(_p, code) {
    return code === FIXED
  },
}

afterAll(async () => {
  for (const p of [phone, freshPhone]) {
    const u = await findUserByIdentity("phone", p)
    if (u) await getDb().delete(users).where(eq(users.id, u.id))
  }
})

describe("/auth flow", () => {
  const app = createApp({ pingDb: async () => true, smsCode: fakeSms })

  it("send -> 200", async () => {
    const res = await app.request("/auth/sms/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone }),
    })
    expect(res.status).toBe(200)
  })

  it("verify with wrong code -> 401", async () => {
    // 带 agreedToTerms 以越过“先判协议”，真正测错码（terms-first：未同意协议不会消费码）
    const res = await app.request("/auth/sms/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone, code: "000000", agreedToTerms: true }),
    })
    expect(res.status).toBe(401)
  })

  it("新号未同意协议 -> 400 terms_required", async () => {
    const res = await app.request("/auth/sms/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: freshPhone, code: FIXED }), // 无 agreedToTerms
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("terms_required")
  })

  it("verify(同意协议) -> token + isNew; /me with token; /me without -> 401; logout 失效", async () => {
    const vr = await app.request("/auth/sms/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone, code: FIXED, agreedToTerms: true }),
    })
    expect(vr.status).toBe(200)
    const { token, isNew } = (await vr.json()) as { token: string; isNew: boolean }
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(isNew).toBe(true) // 首次自动建号

    const me = await app.request("/auth/me", { headers: { Authorization: `Bearer ${token}` } })
    expect(me.status).toBe(200)
    expect(((await me.json()) as { id: string }).id).toBeTruthy()

    const noauth = await app.request("/auth/me")
    expect(noauth.status).toBe(401)

    const lo = await app.request("/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(lo.status).toBe(200)
    const after = await app.request("/auth/me", { headers: { Authorization: `Bearer ${token}` } })
    expect(after.status).toBe(401)
  })
})

describe("/auth/sms/send captcha 钩子", () => {
  const captchaPhone = `+8613${(Date.now() + 11).toString().slice(-9)}`

  it("captchaEnabled + verifyCaptcha 判负 -> 403 captcha_required", async () => {
    const app = createApp({
      pingDb: async () => true,
      smsCode: fakeSms,
      captchaEnabled: true,
      verifyCaptcha: async () => false,
    })
    const res = await app.request("/auth/sms/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: captchaPhone }),
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe("captcha_required")
  })

  it("captchaEnabled + verifyCaptcha 判正 -> 放行 200", async () => {
    const app = createApp({
      pingDb: async () => true,
      smsCode: fakeSms,
      captchaEnabled: true,
      verifyCaptcha: async () => true,
    })
    const res = await app.request("/auth/sms/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: captchaPhone }),
    })
    expect(res.status).toBe(200)
  })
})
