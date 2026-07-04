import { describe, it, expect } from "bun:test"
import { createApiClient, ApiError } from "../lib/api-client"

function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  return async (url: string | URL | Request, init?: RequestInit) => {
    const { status, body } = handler(String(url), init)
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  }
}

describe("api-client", () => {
  it("verifySmsCode 成功返回 token + user，并打到正确路径", async () => {
    let seen: { url: string; init?: RequestInit } | null = null
    const client = createApiClient({
      baseUrl: "http://api.test",
      getToken: () => null,
      fetchImpl: fakeFetch((url, init) => {
        seen = { url, init }
        return { status: 200, body: { token: "t1", user: { id: "u1", nickname: null } } }
      }),
    })
    const r = await client.authApi.verifySmsCode("+8613900000000", "123456")
    expect(r.token).toBe("t1")
    expect(seen!.url).toBe("http://api.test/auth/sms/verify")
  })

  it("verifySmsCode 带邀请码进 body（推荐链接注册）", async () => {
    let body: unknown = null
    const client = createApiClient({
      baseUrl: "http://api.test",
      getToken: () => null,
      fetchImpl: fakeFetch((_url, init) => {
        body = JSON.parse(String(init?.body))
        return { status: 200, body: { token: "t1", isNew: true, user: { id: "u1", nickname: null } } }
      }),
    })
    await client.authApi.verifySmsCode("+8613900000000", "123456", true, "ABC123")
    expect(body).toMatchObject({ phone: "+8613900000000", code: "123456", agreedToTerms: true, referralCode: "ABC123" })
  })

  it("me 带 Authorization Bearer", async () => {
    let auth: string | null = null
    const client = createApiClient({
      baseUrl: "http://api.test",
      getToken: () => "tok-9",
      fetchImpl: fakeFetch((_url, init) => {
        auth = new Headers(init?.headers).get("authorization")
        return { status: 200, body: { id: "u1", nickname: null, status: "active" } }
      }),
    })
    await client.authApi.me()
    expect(auth).toBe("Bearer tok-9")
  })

  it("401 触发 onUnauthorized 回调（令牌失效）", async () => {
    let called = 0
    const client = createApiClient({
      baseUrl: "http://api.test",
      getToken: () => "tok",
      onUnauthorized: () => {
        called++
      },
      fetchImpl: fakeFetch(() => ({ status: 401, body: { error: "invalid_code" } })),
    })
    try {
      await client.authApi.me()
    } catch {
      // 预期抛 ApiError
    }
    expect(called).toBe(1)
  })

  it("未带令牌的 401（登录失败）不触发 onUnauthorized", async () => {
    let called = 0
    const client = createApiClient({
      baseUrl: "http://api.test",
      getToken: () => null,
      onUnauthorized: () => {
        called++
      },
      fetchImpl: fakeFetch(() => ({ status: 401, body: { error: "invalid_code" } })),
    })
    try {
      await client.authApi.verifySmsCode("+8613900000000", "000000")
    } catch {
      // 预期抛 ApiError
    }
    expect(called).toBe(0)
  })

  it("非 2xx 抛 ApiError（含 status / code / retryAfter）", async () => {
    const client = createApiClient({
      baseUrl: "http://api.test",
      getToken: () => null,
      fetchImpl: fakeFetch(() => ({ status: 429, body: { error: "too_many_requests", retryAfter: 42 } })),
    })
    try {
      await client.authApi.sendSmsCode("+8613900000000")
      throw new Error("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError)
      expect((e as ApiError).status).toBe(429)
      expect((e as ApiError).code).toBe("too_many_requests")
      expect((e as ApiError).retryAfter).toBe(42)
    }
  })
})
