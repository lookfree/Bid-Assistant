import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { inArray } from "drizzle-orm"
import { Hono } from "hono"
import { authRoutes } from "../src/routes/auth"
import { loginWithPhone, AccountBannedError } from "../src/services/auth"
import { makeWechatAuth } from "../src/services/wechat-auth"
import { banUser, unbanUser } from "../src/services/admin/admin-users"
import { getDb, closeDb } from "../src/db/client"
import { users } from "../src/db/schema"
import type { SmsCodeService } from "../src/services/sms-code"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程真库（跑法：./test-local.sh test/auth-banned.test.ts）

// 封禁执行链（运营后台封禁必须立刻对 C 端生效——此前只写 users.status，鉴权/登录都不看它，
// 封禁账号既有会话照常用、还能重新登录）：
//  1) authMiddleware 咽喉点：封禁 → 403 account_banned（所有 C 端路由统一生效）；
//  2) 手机号登录：封禁即拒且不烧验证码；路由映射 403 account_banned；
//  3) 微信登录：同一拦截；
//  4) 解封即恢复（会话不吊销——封禁语义可逆，不误伤令牌）。
const smsAlwaysOk: SmsCodeService = {
  request: async () => ({ ok: true as const }),
  verify: async () => "ok" as const,
}
const app = new Hono()
app.route("/auth", authRoutes({ smsCode: smsAlwaysOk, sessionTtlDays: 30, captchaEnabled: false, verifyCaptcha: async () => true }))

const madeUsers: string[] = []
let phone = ""
let token = ""
let userId = ""

const me = (tk: string) => app.request("http://x/auth/me", { headers: { Authorization: `Bearer ${tk}` } })

beforeAll(async () => {
  phone = uniquePhone()
  const a = await loginWithPhone(phone, { agreedToTerms: true }, 30, async () => "ok" as const)
  token = a.token
  userId = a.user.id
  madeUsers.push(userId)
})

afterAll(async () => {
  await getDb().delete(users).where(inArray(users.id, madeUsers)) // sessions 随 user 级联删
  await closeDb()
})

describe("封禁账号全线拒止（评审:封禁账号仍可正常使用投标助手）", () => {
  it("既有会话：封禁 → 所有带鉴权请求 403 account_banned；解封 → 立即恢复（会话不吊销）", async () => {
    expect((await me(token)).status).toBe(200)

    await banUser(userId, { operator: "ops_test" })
    const banned = await me(token)
    expect(banned.status).toBe(403)
    expect(((await banned.json()) as { error?: string }).error).toBe("account_banned")

    await unbanUser(userId, { operator: "ops_test" })
    expect((await me(token)).status).toBe(200)
  })

  it("手机号重新登录：封禁即拒（AccountBannedError），验证码不被消费", async () => {
    await banUser(userId, { operator: "ops_test" })
    let codeConsumed = false
    const attempt = loginWithPhone(phone, { agreedToTerms: true }, 30, async () => {
      codeConsumed = true
      return "ok" as const
    })
    await expect(attempt).rejects.toBeInstanceOf(AccountBannedError)
    expect(codeConsumed).toBe(false) // 拒于消费码之前——用户的一次性码不被烧
  })

  it("/auth/sms/verify 路由：封禁 → 403 account_banned（前端 auth-errors 按此码显示文案）", async () => {
    const res = await app.request("http://x/auth/sms/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone, code: "123456" }),
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error?: string }).error).toBe("account_banned")
  })

  it("微信登录：封禁账号同一拦截（unionid 已绑定的老用户重登被拒）", async () => {
    // 最小 redis 桩：createState 的 set、state/绑定态的一次性 getdel、绑定态的 get
    const store = new Map<string, string>()
    const redis = {
      set: async (k: string, v: string) => (store.set(k, v), "OK" as const),
      get: async (k: string) => store.get(k) ?? null,
      getdel: async (k: string) => {
        const v = store.get(k) ?? null
        store.delete(k)
        return v
      },
    }
    const identifier = `test-union-${userId}`
    const wx = makeWechatAuth(
      redis as never,
      { exchangeCode: async () => ({ openid: identifier, unionid: identifier, nickname: "封禁测试" }) } as never,
      30,
    )
    // 先解封注册绑定 wechat 身份（微信登录必须绑手机号，账号在绑定这一步才建），再封禁后重登 → 必须被拒
    await unbanUser(userId, { operator: "ops_test" })
    const first = await wx.login("code1", await wx.createState(true), {})
    if (!first.needBindPhone) throw new Error("首个微信身份应进绑定态")
    const bound = await wx.bindPhone(first.bindToken, uniquePhone(), {}, async () => "ok" as const)
    madeUsers.push(bound.user.id) // 新建的微信账号（与手机号账号不同人）也要清理
    await banUser(bound.user.id, { operator: "ops_test" })
    const again = wx.login("code2", await wx.createState(true), {})
    await expect(again).rejects.toBeInstanceOf(AccountBannedError)
  })
})
