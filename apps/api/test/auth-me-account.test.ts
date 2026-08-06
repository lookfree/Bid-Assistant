import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { inArray } from "drizzle-orm"
import { Hono } from "hono"
import { authRoutes } from "../src/routes/auth"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users } from "../src/db/schema"
import type { SmsCodeService } from "../src/services/sms-code"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS)

// 会员中心此前不显示"这是谁的账号"——/auth/me 只回 id/nickname/status，连手机号都没有，
// 用户在会员中心看不出自己登录的是哪个号（多号切换、代客操作时尤其要紧）。
const smsAlwaysOk: SmsCodeService = { request: async () => ({ ok: true as const }), verify: async () => "ok" as const }
const app = new Hono()
app.route("/auth", authRoutes({ smsCode: smsAlwaysOk, sessionTtlDays: 30, captchaEnabled: false, verifyCaptcha: async () => true }))

const madeUsers: string[] = []
let phone = ""
let token = ""

beforeAll(async () => {
  phone = uniquePhone()
  const a = await loginWithPhone(phone, { agreedToTerms: true }, 30, async () => "ok" as const)
  token = a.token
  madeUsers.push(a.user.id)
})
afterAll(async () => {
  if (madeUsers.length) await getDb().delete(users).where(inArray(users.id, madeUsers))
  await closeDb()
})

describe("/auth/me 带回账号标识", () => {
  it("回打码手机号，用户据此认得出是哪个账号", async () => {
    const res = await app.request("http://x/auth/me", { headers: { Authorization: `Bearer ${token}` } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string; nickname: string | null; status: string; phone: string | null }
    expect(body.phone).toBe(`${phone.slice(0, 3)}****${phone.slice(-4)}`)
  })

  it("不回完整手机号——展示用途不需要，回了就是白白多暴露一份", async () => {
    const res = await app.request("http://x/auth/me", { headers: { Authorization: `Bearer ${token}` } })
    const body = (await res.json()) as { phone: string | null }
    expect(body.phone).not.toBe(phone)
    expect(body.phone).toContain("****")
  })
})

// 评审 LOW：登录响应此前不带手机号，手机号注册的用户（nickname 为空）在整页刷新之前，
// 会员中心的「当前账号」只显示"已登录"——正好是这个功能要解决的场景。
describe("登录响应带回账号标识", () => {
  it("验证码登录即刻带回打码手机号，不必等刷新", async () => {
    const p = uniquePhone()
    const res = await app.request("http://x/auth/sms/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: p, code: "123456", agreedToTerms: true }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { user: { id: string; phone: string | null } }
    madeUsers.push(body.user.id)
    expect(body.user.phone).toBe(`${p.slice(0, 3)}****${p.slice(-4)}`)
  })
})
