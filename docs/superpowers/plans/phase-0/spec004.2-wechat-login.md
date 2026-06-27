# spec004.2 · 微信扫码登录 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加 C 端微信开放平台「网站应用扫码登录」：前端展示二维码 → 用户微信扫码授权 → 回跳前端页 → 后端用 `code` 换 `openid/unionid` → 按 `user_identities(wechat)` 找/建账号 → 签发会话令牌。**复用 spec003 身份模型（wechat provider）与 spec004 的会话/协议同意/isNew，零 schema 改动。**

**Architecture:** 微信 OAuth 抽象成 `WechatOAuthClient`（真实 fetch 实现 + 开发伪实现，按凭据/环境切换）；登录态 CSRF 用 Redis `wxstate:<state>` 暂存（含协议同意位）。后端出 `/auth/wechat/url`（建 state + 返回二维码参数）与 `/auth/wechat/login`（code+state 换登录）。前端 `/login` 加「微信登录」页签 + 回调页。

**Tech Stack:** Hono、ioredis、`fetch`（微信 OAuth 为简单 HTTP，无需 SDK）、Next.js（前端二维码/回调）、`bun:test`。

## Global Constraints

见 `spec000-index.md`。本 spec 关键约束：
- 身份键优先用 **unionid**（开放平台跨应用稳定），缺失退化 openid；落 `user_identities(provider="wechat")`。
- 微信开放平台凭据**当前可能缺失** → 有凭据用 `RealWechatOAuthClient`，否则**非生产**用 `DevWechatOAuthClient`（伪 openid，便于端到端联调）、**生产** fail-closed。
- 微信首登即注册：同手机号一致，需协议同意（`agreedToTerms` 随 state 暂存）；复用 `TermsRequiredError`/`isNew`。
- 令牌不透明、落 `sessions`（复用 spec004）。
- 集成测试连真 Redis/真 DB（bidsaas），`--env-file`，自清理。
- 在 `main` 上先开分支再改；提交信息结尾附 Co-Authored-By。

---

## File Structure

```
apps/api/
├── src/
│   ├── config/env.ts                 # 改：补 WECHAT_APP_ID/SECRET/REDIRECT_URI
│   ├── services/
│   │   ├── wechat-oauth.ts           # 新：WechatOAuthClient 接口 + Real/Dev + 工厂
│   │   └── wechat-auth.ts            # 新：state 暂存 + loginWithWechat
│   ├── routes/wechat.ts              # 新：/auth/wechat/url、/auth/wechat/login
│   ├── app.ts                        # 改：deps 注入 wechat，挂 /auth/wechat
│   └── index.ts                      # 改：装配 wechat
└── test/routes/wechat.test.ts        # 新：集成（Dev 客户端 + 真 DB/Redis）
apps/web/
├── lib/api-client.ts                 # 改：加 wechatAuthUrl / wechatLogin
├── app/login/page.tsx                # 改：加「微信登录」页签（二维码）
└── app/login/wechat/page.tsx         # 新：微信回调页（读 code/state → 换登录）
```

---

## Interfaces（本 spec 对外产出）

- Produces：
  - `WechatOAuthClient { exchangeCode(code): Promise<{ openid: string; unionid?: string; nickname?: string; avatar?: string }> }`
  - `makeWechatAuth(redis, oauth, ttlDays)` → `{ createState(agreedToTerms): Promise<string>; login(code, state, meta): Promise<{ token; user; isNew }> }`
  - HTTP 契约：
    - `POST /auth/wechat/url` body `{ agreedToTerms? }` → `200 { state, appId, scope:"snsapi_login", redirectUri }`
    - `POST /auth/wechat/login` body `{ code, state }` → `200 { token, isNew, user:{ id, nickname } }` / `400 { error:"invalid_state" | "terms_required" }` / `401 { error:"wechat_login_failed" }`

---

## Task 1: env + WechatOAuthClient（真实 fetch + 开发伪实现）

**Files:**
- Modify: `apps/api/src/config/env.ts`
- Create: `apps/api/src/services/wechat-oauth.ts`

- [ ] **Step 1: 开分支**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout -b phase0/spec004.2-wechat
```

- [ ] **Step 2: env 加微信凭据（schema 内追加，均 optional）**

```ts
  WECHAT_APP_ID: z.string().optional(),
  WECHAT_APP_SECRET: z.string().optional(),
  WECHAT_REDIRECT_URI: z.string().default("http://localhost:3000/login/wechat"),
```

- [ ] **Step 3: 写 `apps/api/src/services/wechat-oauth.ts`**

```ts
import type { Env } from "../config/env"

export type WechatProfile = { openid: string; unionid?: string; nickname?: string; avatar?: string }

export interface WechatOAuthClient {
  exchangeCode(code: string): Promise<WechatProfile>
}

/** 真实：微信网站应用 OAuth2（简单 HTTP，无需 SDK）。 */
export class RealWechatOAuthClient implements WechatOAuthClient {
  constructor(
    private cfg: { appId: string; appSecret: string },
    private fetchImpl: typeof fetch = fetch,
  ) {}
  async exchangeCode(code: string): Promise<WechatProfile> {
    const tokUrl =
      `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${this.cfg.appId}` +
      `&secret=${this.cfg.appSecret}&code=${encodeURIComponent(code)}&grant_type=authorization_code`
    const tok = (await (await this.fetchImpl(tokUrl)).json()) as any
    if (tok.errcode) throw new Error(`wechat oauth token: ${tok.errcode} ${tok.errmsg}`)
    let nickname: string | undefined
    let avatar: string | undefined
    let unionid: string | undefined = tok.unionid
    try {
      const ui = (await (
        await this.fetchImpl(`https://api.weixin.qq.com/sns/userinfo?access_token=${tok.access_token}&openid=${tok.openid}`)
      ).json()) as any
      if (!ui.errcode) {
        nickname = ui.nickname
        avatar = ui.headimgurl
        unionid = ui.unionid ?? unionid
      }
    } catch {
      /* userinfo 失败不阻断登录 */
    }
    return { openid: tok.openid, unionid, nickname, avatar }
  }
}

/** 开发：无凭据时返回确定性伪身份，便于端到端联调。 */
export class DevWechatOAuthClient implements WechatOAuthClient {
  async exchangeCode(code: string): Promise<WechatProfile> {
    return { openid: `dev_open_${code}`, unionid: `dev_union_${code}`, nickname: "微信用户(dev)" }
  }
}

export function createWechatOAuthClient(env: Env): WechatOAuthClient {
  if (env.WECHAT_APP_ID && env.WECHAT_APP_SECRET) {
    return new RealWechatOAuthClient({ appId: env.WECHAT_APP_ID, appSecret: env.WECHAT_APP_SECRET })
  }
  if (env.NODE_ENV === "production") {
    throw new Error("[wechat] 生产缺少微信开放平台凭据（WECHAT_APP_ID/SECRET）")
  }
  console.warn("[wechat] 无微信凭据，开发期用 DevWechatOAuthClient（伪 openid）")
  return new DevWechatOAuthClient()
}
```

- [ ] **Step 4: 类型检查 + 提交**

Run: `cd apps/api && bun run typecheck`
Expected: 通过。

```bash
git add apps/api/src/config/env.ts apps/api/src/services/wechat-oauth.ts
git commit -m "feat(spec004.2): 微信 OAuth 客户端(真实 fetch + 开发伪实现)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 微信登录服务（state 暂存 + 找/建账号）

**Files:**
- Create: `apps/api/src/services/wechat-auth.ts`

**Interfaces:**
- Consumes: spec003 仓储、spec004 `hashToken`/`TermsRequiredError`、`WechatOAuthClient`。
- Produces: `makeWechatAuth(redis, oauth, ttlDays)`。

- [ ] **Step 1: 写 `apps/api/src/services/wechat-auth.ts`**

```ts
import { randomBytes } from "node:crypto"
import type { Redis } from "ioredis"
import { findUserByIdentity, createUserWithIdentity } from "../repos/users"
import { createSession } from "../repos/sessions"
import { hashToken, TermsRequiredError } from "./auth"
import type { WechatOAuthClient } from "./wechat-oauth"
import type { User } from "../db/schema"

export class InvalidStateError extends Error {
  constructor() {
    super("invalid_state")
  }
}

export function makeWechatAuth(redis: Redis, oauth: WechatOAuthClient, ttlDays: number) {
  return {
    async createState(agreedToTerms: boolean): Promise<string> {
      const state = randomBytes(16).toString("hex")
      await redis.set(`wxstate:${state}`, JSON.stringify({ agreedToTerms }), "EX", 600)
      return state
    },

    async login(
      code: string,
      state: string,
      meta: { userAgent?: string; ip?: string },
    ): Promise<{ token: string; user: User; isNew: boolean }> {
      const raw = await redis.get(`wxstate:${state}`)
      if (!raw) throw new InvalidStateError()
      await redis.del(`wxstate:${state}`) // 一次性
      const { agreedToTerms } = JSON.parse(raw) as { agreedToTerms: boolean }

      const profile = await oauth.exchangeCode(code)
      const identifier = profile.unionid ?? profile.openid // 优先 unionid

      let user = await findUserByIdentity("wechat", identifier)
      let isNew = false
      if (!user) {
        if (!agreedToTerms) throw new TermsRequiredError()
        user = await createUserWithIdentity({
          provider: "wechat",
          identifier,
          verifiedAt: new Date(),
          nickname: profile.nickname,
          termsAgreedAt: new Date(),
        })
        isNew = true
      }
      const token = randomBytes(32).toString("hex")
      await createSession({
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + ttlDays * 86_400_000),
        userAgent: meta.userAgent,
        ip: meta.ip,
      })
      return { token, user, isNew }
    },
  }
}
```

- [ ] **Step 2: 类型检查 + 提交**

Run: `cd apps/api && bun run typecheck`
Expected: 通过。

```bash
git add apps/api/src/services/wechat-auth.ts
git commit -m "feat(spec004.2): 微信登录服务(state 暂存 + 找/建账号 + 会话)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: /auth/wechat 路由 + 装配 + 集成测试

**Files:**
- Create: `apps/api/src/routes/wechat.ts`、`apps/api/test/routes/wechat.test.ts`
- Modify: `apps/api/src/app.ts`、`apps/api/src/index.ts`

**Interfaces:**
- Produces: `/auth/wechat/url`、`/auth/wechat/login`；`createApp` 可选挂载 wechat。

- [ ] **Step 1: 写 `apps/api/src/routes/wechat.ts`**

```ts
import { Hono } from "hono"
import { z } from "zod"
import { TermsRequiredError } from "../services/auth"
import { InvalidStateError, makeWechatAuth } from "../services/wechat-auth"

export type WechatRouteDeps = {
  wechat: ReturnType<typeof makeWechatAuth>
  appId: string
  redirectUri: string
}

export function wechatRoutes(deps: WechatRouteDeps) {
  const r = new Hono()

  r.post("/url", async (c) => {
    const body = z.object({ agreedToTerms: z.boolean().optional() }).safeParse(await c.req.json().catch(() => ({})))
    const state = await deps.wechat.createState(body.success ? !!body.data.agreedToTerms : false)
    return c.json({ state, appId: deps.appId, scope: "snsapi_login", redirectUri: deps.redirectUri })
  })

  r.post("/login", async (c) => {
    const body = z.object({ code: z.string().min(1), state: z.string().min(1) }).safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid_input" }, 400)
    const ip = c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() || c.req.header("X-Real-IP")
    try {
      const { token, user, isNew } = await deps.wechat.login(body.data.code, body.data.state, {
        userAgent: c.req.header("User-Agent"),
        ip,
      })
      return c.json({ token, isNew, user: { id: user.id, nickname: user.nickname } })
    } catch (e) {
      if (e instanceof TermsRequiredError) return c.json({ error: "terms_required" }, 400)
      if (e instanceof InvalidStateError) return c.json({ error: "invalid_state" }, 400)
      return c.json({ error: "wechat_login_failed" }, 401)
    }
  })

  return r
}
```

- [ ] **Step 2: 改 `apps/api/src/app.ts` 注入 wechat 并挂载**

在 `AppDeps` 加可选字段，并在 `createApp` 内挂载：

```ts
import { wechatRoutes } from "./routes/wechat"
import type { makeWechatAuth } from "./services/wechat-auth"

// AppDeps 追加：
  wechat?: { service: ReturnType<typeof makeWechatAuth>; appId: string; redirectUri: string }

// createApp 内（挂在 /auth 之后）：
  if (deps.wechat) {
    app.route(
      "/auth/wechat",
      wechatRoutes({ wechat: deps.wechat.service, appId: deps.wechat.appId, redirectUri: deps.wechat.redirectUri }),
    )
  }
```

- [ ] **Step 3: 改 `apps/api/src/index.ts` 装配 wechat**

```ts
import { createWechatOAuthClient } from "./services/wechat-oauth"
import { makeWechatAuth } from "./services/wechat-auth"

// 在 createApp(...) 之前构造：
const wechatService = makeWechatAuth(redis, createWechatOAuthClient(env), env.AUTH_SESSION_TTL_DAYS)
// createApp 调用的 deps 里加：
//   wechat: { service: wechatService, appId: env.WECHAT_APP_ID ?? "", redirectUri: env.WECHAT_REDIRECT_URI }
```

- [ ] **Step 4: 写集成测试 `apps/api/test/routes/wechat.test.ts`（Dev 客户端）**

```ts
import { describe, it, expect, afterAll } from "bun:test"
import { createApp } from "../../src/app"
import { makeWechatAuth } from "../../src/services/wechat-auth"
import { DevWechatOAuthClient } from "../../src/services/wechat-oauth"
import { redis } from "../../src/redis/client"
import { findUserByIdentity } from "../../src/repos/users"
import { db } from "../../src/db/client"
import { users } from "../../src/db/schema"
import { eq } from "drizzle-orm"

const code = `c_${Date.now()}`
const unionid = `dev_union_${code}` // 与 DevWechatOAuthClient 一致

afterAll(async () => {
  const u = await findUserByIdentity("wechat", unionid)
  if (u) await db.delete(users).where(eq(users.id, u.id))
  redis.disconnect()
})

const service = makeWechatAuth(redis, new DevWechatOAuthClient(), 30)
const app = createApp({
  pingDb: async () => true,
  wechat: { service, appId: "wxtest", redirectUri: "http://localhost:3000/login/wechat" },
})

async function getState(agreedToTerms: boolean): Promise<string> {
  const res = await app.request("/auth/wechat/url", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agreedToTerms }),
  })
  return (await res.json()).state as string
}

describe("/auth/wechat", () => {
  it("url 返回 state + appId", async () => {
    const res = await app.request("/auth/wechat/url", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agreedToTerms: true }),
    })
    expect(res.status).toBe(200)
    const b = await res.json()
    expect(b.appId).toBe("wxtest")
    expect(b.state).toMatch(/^[0-9a-f]{32}$/)
  })

  it("新号未同意协议 -> 400 terms_required", async () => {
    const state = await getState(false)
    const res = await app.request("/auth/wechat/login", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, state }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("terms_required")
  })

  it("无效 state -> 400 invalid_state", async () => {
    const res = await app.request("/auth/wechat/login", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, state: "deadbeef" }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_state")
  })

  it("同意协议 -> token + isNew=true；同 unionid 复登 isNew=false", async () => {
    const r1 = await app.request("/auth/wechat/login", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, state: await getState(true) }),
    })
    expect(r1.status).toBe(200)
    const b1 = await r1.json()
    expect(b1.token).toMatch(/^[0-9a-f]{64}$/)
    expect(b1.isNew).toBe(true)

    const r2 = await app.request("/auth/wechat/login", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, state: await getState(false) }),
    })
    expect((await r2.json()).isNew).toBe(false) // 已存在，复登无需协议
  })
})
```

- [ ] **Step 5: 运行测试（真 Redis + 真 DB）**

Run: `cd apps/api && bun --env-file=../../.env.bidsaas.local test test/routes/wechat.test.ts`
Expected: PASS（4 项），自清理。

- [ ] **Step 6: 提交**

```bash
git add apps/api/src/routes/wechat.ts apps/api/src/app.ts apps/api/src/index.ts apps/api/test/routes/wechat.test.ts
git commit -m "feat(spec004.2): /auth/wechat 路由 + 装配 + 集成测试

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 前端「微信登录」页签 + 二维码 + 回调页

**Files:**
- Modify: `apps/web/lib/api-client.ts`、`apps/web/app/login/page.tsx`
- Create: `apps/web/app/login/wechat/page.tsx`

**Interfaces:**
- Consumes: spec005 的 `api`/`useAuth`。

- [ ] **Step 1: api-client 加微信两个方法**

在 `authApi` 内追加：

```ts
    wechatAuthUrl: (agreedToTerms: boolean) =>
      post<{ state: string; appId: string; scope: string; redirectUri: string }>("/auth/wechat/url", { agreedToTerms }),
    wechatLogin: (code: string, state: string) =>
      post<{ token: string; isNew: boolean; user: { id: string; nickname: string | null } }>("/auth/wechat/login", { code, state }),
```

- [ ] **Step 2: `/login` 加「微信登录」页签（展示二维码）**

在登录页加 Tab：手机号登录 / 微信登录。微信页签里（需先勾选协议）点「生成二维码」：

```tsx
// 取 url 参数后，用微信官方 JS 渲染二维码（嵌入 open.weixin.qq.com 的 iframe）
async function showWechatQr(agreed: boolean, mountId: string, setMsg: (s: string) => void) {
  if (!agreed) { setMsg("请先同意协议"); return }
  const { state, appId, scope, redirectUri } = await api.authApi.wechatAuthUrl(agreed)
  // 微信网站应用 JS：new WxLogin({ id, appid, scope, redirect_uri, state })
  // redirect_uri 必须 urlEncode；引入 https://res.wx.qq.com/connect/zh_CN/htmledition/js/wxLogin.js
  // @ts-expect-error 微信全局对象
  new WxLogin({ id: mountId, appid: appId, scope, redirect_uri: encodeURIComponent(redirectUri), state })
}
```
> 开发期无凭据：用 DevWechatOAuthClient，二维码扫不通（无真 appId）。联调可跳过二维码，直接在回调页用任意 `code` + 真实 `state`（先调 `/auth/wechat/url` 拿 state）测全链路。

- [ ] **Step 3: 写回调页 `apps/web/app/login/wechat/page.tsx`**

```tsx
"use client"
import { useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { api } from "@/lib/api"
import { useAuth } from "@/components/auth/auth-provider"

export default function WechatCallback() {
  const params = useSearchParams()
  const router = useRouter()
  const { login } = useAuth()
  const [msg, setMsg] = useState("正在登录…")

  useEffect(() => {
    const code = params.get("code")
    const state = params.get("state")
    if (!code || !state) { setMsg("缺少授权参数"); return }
    api.authApi
      .wechatLogin(code, state)
      .then(({ token, user, isNew }) => {
        login(token, user)
        router.replace(isNew ? "/onboarding" : "/projects")
      })
      .catch(() => setMsg("微信登录失败，请重试"))
  }, [params, router, login])

  return <div className="p-8 text-center text-muted-foreground">{msg}</div>
}
```

- [ ] **Step 4: 端到端冒烟（开发期，Dev 客户端）**

```bash
cd apps/api && bun run api    # :8080
cd apps/web && bun run web    # :3000
# 1) 调 url 拿 state（勾选同意）
curl -s -XPOST localhost:8080/auth/wechat/url -H 'content-type: application/json' -d '{"agreedToTerms":true}'
# 2) 浏览器开 http://localhost:3000/login/wechat?code=devcode1&state=<上一步 state>
#    -> 自动登录并跳转
```
Expected: 回调页用 `devcode1`+state 调 `/auth/wechat/login`，DevWechatOAuthClient 给伪 unionid，建号并登录跳转。
> 清理冒烟用户：删 `user_identities` 中 `provider='wechat' identifier='dev_union_devcode1'` 对应用户。

- [ ] **Step 5: 全量校验 + 提交合并**

Run: `cd apps/web && bun run build` 与 `cd apps/api && bun --env-file=../../.env.bidsaas.local test`
Expected: 构建成功、测试全绿。

```bash
git add apps/web/lib/api-client.ts apps/web/app/login
git commit -m "feat(spec004.2): 前端微信登录页签 + 二维码 + 回调页

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git checkout main
git merge --no-ff phase0/spec004.2-wechat -m "merge spec004.2: 微信扫码登录"
git push origin main
```

---

## 验收清单（spec004.2 完成判据）

- [ ] `POST /auth/wechat/url` 返回 `state`+`appId`+`redirectUri`；state 落 Redis（含协议同意位，TTL 10 分钟、一次性）。
- [ ] `POST /auth/wechat/login`：有效 code+state → `token`+`isNew`+`user`；无效 state → 400 invalid_state；新号未同意 → 400 terms_required。
- [ ] 身份按 `unionid`（缺失用 openid）落 `user_identities(wechat)`；首登建号、复登复用（isNew 正确）。
- [ ] 凭据缺失：非生产用 DevWechatOAuthClient（伪身份联调）、生产 fail-closed。
- [ ] 前端「微信登录」页签 + 回调页打通（开发期用 Dev 客户端走伪 code）。
- [ ] **零 schema 改动**（复用 `user_identities` 的 wechat provider）。
- [ ] 同一用户可同时绑手机号 + 微信两身份（复用 spec003 `addIdentity`）。
