import { describe, it, expect, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { createApp } from "../../src/app"
import { makeWechatAuth } from "../../src/services/wechat-auth"
import { DevWechatOAuthClient } from "../../src/services/wechat-oauth"
import { getRedis, closeRedis } from "../../src/redis/client"
import { findUserByIdentity } from "../../src/repos/users"
import { getDb } from "../../src/db/client"
import { users } from "../../src/db/schema"
import type { SmsCodeService } from "../../src/services/sms-code"
import { getBalance } from "../../src/services/credits"
import { TEST_TIMEOUT_MS } from "../repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB/Redis

/* 2026-08-17 用户拍板：微信登录必须绑手机号。
   本文件钉死三条不可退让的语义——绑定完成前不建号、手机号已有账号则挂靠、验证码错不作废绑定态。 */

const FIXED = "123456"
const fakeSms: SmsCodeService = {
  async request() {
    return { ok: true }
  },
  async verify(_p, code) {
    return code === FIXED ? ("ok" as const) : ("mismatch" as const)
  },
}

const codes: string[] = [] // 每个用例一个微信 code → 一个独立 unionid
const phones: string[] = []
function wxCode(tag: string): string {
  const c = `c_${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  codes.push(c)
  return c
}
let seq = 0
function phone(): string {
  // 带自增位：共享 helpers 的 uniquePhone 只吃时间戳，本文件同毫秒内要多个号会撞
  const p = `+8613${String(Date.now()).slice(-7)}${String(seq++).padStart(2, "0")}`
  phones.push(p)
  return p
}

afterAll(async () => {
  for (const c of codes) {
    const u = await findUserByIdentity("wechat", `dev_union_${c}`)
    if (u) await getDb().delete(users).where(eq(users.id, u.id))
  }
  for (const p of phones) {
    const u = await findUserByIdentity("phone", p)
    if (u) await getDb().delete(users).where(eq(users.id, u.id))
  }
  await closeRedis()
})

const app = createApp({
  pingDb: async () => true,
  smsCode: fakeSms,
  wechat: {
    service: makeWechatAuth(getRedis(), new DevWechatOAuthClient(), 30),
    appId: "wxtest",
    redirectUri: "http://localhost:3000/login/wechat",
  },
})

const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

async function scan(code: string): Promise<Record<string, unknown>> {
  const state = ((await (await post("/auth/wechat/url", { agreedToTerms: true })).json()) as { state: string }).state
  const res = await post("/auth/wechat/login", { code, state })
  expect(res.status).toBe(200)
  return (await res.json()) as Record<string, unknown>
}

describe("微信登录必须绑手机号", () => {
  it("扫码不再直接发会话：回绑定态，且此时**没有**建号", async () => {
    const code = wxCode("nosession")
    const body = await scan(code)
    expect(body.needBindPhone).toBe(true)
    expect(typeof body.bindToken).toBe("string")
    expect(body.token).toBeUndefined() // 没绑手机号就发会话 = 这个功能白做
    expect(await findUserByIdentity("wechat", `dev_union_${code}`)).toBeNull() // 绑定前不留孤儿账号
  })

  it("绑一个没注册过的手机号：建号 + 发会话，两种身份指向同一账号", async () => {
    const code = wxCode("newphone")
    const p = phone()
    const { bindToken } = (await scan(code)) as { bindToken: string }
    const res = await post("/auth/wechat/bind-phone", { bindToken, phone: p, code: FIXED })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token: string; isNew: boolean; user: { id: string; phone: string | null } }
    expect(body.token.length).toBeGreaterThan(10)
    expect(body.isNew).toBe(true)
    expect(body.user.phone).toBeTruthy() // 打码手机号，前端"当前账号"要显示
    const byWechat = await findUserByIdentity("wechat", `dev_union_${code}`)
    const byPhone = await findUserByIdentity("phone", p)
    expect(byWechat?.id).toBe(body.user.id)
    expect(byPhone?.id).toBe(body.user.id) // 同一个人 = 同一个账号，不是两个
  })

  it("经微信建的号照样有注册赠送积分（赠分紧跟建号，不挂在发会话之后）", async () => {
    const code = wxCode("bonus")
    const { bindToken } = (await scan(code)) as { bindToken: string }
    const res = await post("/auth/wechat/bind-phone", { bindToken, phone: phone(), code: FIXED })
    const body = (await res.json()) as { user: { id: string } }
    expect(await getBalance(body.user.id)).toBeGreaterThan(0) // 赠多少是运营可配的，只断"有"
  })

  it("绑一个已注册的手机号：挂靠既有账号，不新建（否则积分会分裂在两个号上）", async () => {
    const p = phone()
    const first = await post("/auth/sms/verify", { phone: p, code: FIXED, agreedToTerms: true })
    const existing = (await first.json()) as { user: { id: string } }
    const code = wxCode("existing")
    const { bindToken } = (await scan(code)) as { bindToken: string }
    const res = await post("/auth/wechat/bind-phone", { bindToken, phone: p, code: FIXED })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { isNew: boolean; user: { id: string } }
    expect(body.user.id).toBe(existing.user.id)
    expect(body.isNew).toBe(false) // 不是新号 → 不该再赠一次注册积分
  })

  it("验证码填错：不作废绑定态，改对了还能绑（否则用户得重新扫码）", async () => {
    const code = wxCode("retry")
    const p = phone()
    const { bindToken } = (await scan(code)) as { bindToken: string }
    const bad = await post("/auth/wechat/bind-phone", { bindToken, phone: p, code: "000000" })
    expect(bad.status).toBe(401)
    const good = await post("/auth/wechat/bind-phone", { bindToken, phone: p, code: FIXED })
    expect(good.status).toBe(200)
  })

  it("绑定态一次性：绑成功后同一个 bindToken 不能再换第二个会话", async () => {
    const code = wxCode("once")
    const p = phone()
    const { bindToken } = (await scan(code)) as { bindToken: string }
    expect((await post("/auth/wechat/bind-phone", { bindToken, phone: p, code: FIXED })).status).toBe(200)
    const again = await post("/auth/wechat/bind-phone", { bindToken, phone: phone(), code: FIXED })
    expect(again.status).toBe(400)
    expect(((await again.json()) as { error: string }).error).toBe("invalid_state")
  })

  it("绑过手机号的微信号再扫码：直接发会话，不再要一遍手机号", async () => {
    const code = wxCode("second")
    const p = phone()
    const { bindToken } = (await scan(code)) as { bindToken: string }
    const bound = (await (await post("/auth/wechat/bind-phone", { bindToken, phone: p, code: FIXED })).json()) as {
      user: { id: string }
    }
    const body = await scan(code)
    expect(body.needBindPhone).toBeUndefined()
    expect((body.user as { id: string }).id).toBe(bound.user.id)
  })
})
