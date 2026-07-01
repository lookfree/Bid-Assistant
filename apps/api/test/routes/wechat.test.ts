import { describe, it, expect, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { createApp } from "../../src/app"
import { makeWechatAuth } from "../../src/services/wechat-auth"
import { DevWechatOAuthClient } from "../../src/services/wechat-oauth"
import { getRedis, closeRedis } from "../../src/redis/client"
import { findUserByIdentity } from "../../src/repos/users"
import { getDb } from "../../src/db/client"
import { users } from "../../src/db/schema"
import { TEST_TIMEOUT_MS } from "../repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB/Redis

const code = `c_${Date.now()}`
const unionid = `dev_union_${code}` // 与 DevWechatOAuthClient 一致

afterAll(async () => {
  const u = await findUserByIdentity("wechat", unionid)
  if (u) await getDb().delete(users).where(eq(users.id, u.id))
  await closeRedis()
})

const service = makeWechatAuth(getRedis(), new DevWechatOAuthClient(), 30)
const app = createApp({
  pingDb: async () => true,
  wechat: { service, appId: "wxtest", redirectUri: "http://localhost:3000/login/wechat" },
})

async function getState(agreedToTerms: boolean): Promise<string> {
  const res = await app.request("/auth/wechat/url", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agreedToTerms }),
  })
  return ((await res.json()) as { state: string }).state
}

describe("/auth/wechat", () => {
  it("url 返回 state + appId", async () => {
    const res = await app.request("/auth/wechat/url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agreedToTerms: true }),
    })
    expect(res.status).toBe(200)
    const b = (await res.json()) as { appId: string; state: string }
    expect(b.appId).toBe("wxtest")
    expect(b.state).toMatch(/^[0-9a-f]{32}$/)
  })

  it("新号未同意协议 -> 400 terms_required", async () => {
    const state = await getState(false)
    const res = await app.request("/auth/wechat/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, state }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("terms_required")
  })

  it("无效 state -> 400 invalid_state", async () => {
    const res = await app.request("/auth/wechat/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, state: "deadbeef" }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("invalid_state")
  })

  it("同意协议 -> token + isNew=true；同 unionid 复登 isNew=false", async () => {
    const r1 = await app.request("/auth/wechat/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, state: await getState(true) }),
    })
    expect(r1.status).toBe(200)
    const b1 = (await r1.json()) as { token: string; isNew: boolean }
    expect(b1.token).toMatch(/^[0-9a-f]{64}$/)
    expect(b1.isNew).toBe(true)

    const r2 = await app.request("/auth/wechat/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, state: await getState(false) }),
    })
    expect(((await r2.json()) as { isNew: boolean }).isNew).toBe(false) // 已存在，复登无需协议
  })
})
