# spec005 · 前端接入登录 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `apps/web` 现有 `/login` 原型从 mock 接到真实 App API 的 `/auth/*`（spec004），实现：API 客户端、登录态（令牌持久化 + 当前用户）、`/login` 发码→验证→登录全链路、登录后路由守卫，并给 App API 补 CORS 放行 web 源。

**Architecture:** 纯 TS 的 `token-store` 与 `api-client` 用工厂 + 依赖注入（storage/fetch 可注入）以便 `bun test` 不依赖浏览器；React 层 `AuthProvider`/`useAuth` 封装登录态；登录令牌为不透明 Bearer，存 localStorage（XSS 加固留作后续 BFF httpOnly 方案）。App API 加 `hono/cors`。

**Tech Stack:** Next.js 16/React 19（apps/web）、Hono cors（apps/api）、`bun:test`（lib 层）。

## Global Constraints

见 `spec000-index.md`。本 spec 关键约束：
- 复用现有原型 UI，不改视觉，只换 mock→真实数据。
- 令牌 = 不透明 Bearer（spec004），前端经 `Authorization: Bearer` 携带；base URL 从 `NEXT_PUBLIC_API_BASE_URL` 读。
- 滑块默认开（spec004）：dev 无凭据走 DevPass，前端用 `NEXT_PUBLIC_CAPTCHA_ENABLED`（默认 `false`）决定是否出滑块；为 false 时发码不带 captchaToken，后端 DevPass 放行。
- lib 层（token-store/api-client）必须可单测（注入 storage/fetch）。
- 在 `main` 上先开分支再改；提交信息结尾附 Co-Authored-By。

---

## File Structure

```
apps/api/
└── src/app.ts                     # 改：加 hono/cors（放行 web 源）
apps/web/
├── lib/
│   ├── token-store.ts             # 新：createTokenStore(storage) get/set/clear
│   └── api-client.ts              # 新：createApiClient({baseUrl,getToken,fetchImpl}) + authApi
├── components/auth/
│   ├── auth-provider.tsx          # 新：AuthProvider + useAuth()
│   └── require-auth.tsx           # 新：路由守卫（未登录跳 /login）
├── app/login/page.tsx             # 改：mock → 调 authApi（发码/验证/登录）
├── test/
│   ├── token-store.test.ts        # 新
│   └── api-client.test.ts         # 新
├── .env.local                     # 新（不入库）：NEXT_PUBLIC_API_BASE_URL 等
└── package.json                   # 改：加 test 脚本
```

---

## Interfaces（本 spec 对外产出）

- Produces：
  - `createTokenStore(storage: SimpleStorage)` → `{ get(): string | null; set(t: string): void; clear(): void }`；`SimpleStorage = { getItem; setItem; removeItem }`。默认实例 `tokenStore`（浏览器用 localStorage，SSR/缺失时用内存）。
  - `createApiClient(opts: { baseUrl: string; getToken: () => string | null; fetchImpl?: typeof fetch })` → `{ request; authApi }`；
    - `authApi.sendSmsCode(phone: string, captchaToken?: string): Promise<void>`
    - `authApi.verifySmsCode(phone: string, code: string, agreedToTerms?: boolean): Promise<{ token: string; isNew: boolean; user: { id: string; nickname: string | null } }>`（未注册自动建号，首次需 `agreedToTerms`）
    - `authApi.me(): Promise<{ id: string; nickname: string | null; status: string }>`
    - `authApi.logout(): Promise<void>`
    - 失败抛 `ApiError { status: number; code?: string; retryAfter?: number }`。
  - React：`AuthProvider`、`useAuth() → { user, loading, login(token,user), logout, refresh }`；`<RequireAuth>`。

---

## Task 1: App API 加 CORS（放行 web 源）

**Files:**
- Modify: `apps/api/src/app.ts`、`apps/api/src/config/env.ts`

- [ ] **Step 1: 开分支**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout -b phase0/spec005-web-login
```

- [ ] **Step 2: env 加 `WEB_ORIGINS`（逗号分隔白名单）**

在 `apps/api/src/config/env.ts` schema 加：

```ts
  WEB_ORIGINS: z.string().default("http://localhost:3000,http://localhost:3001"),
```

- [ ] **Step 3: `apps/api/src/app.ts` 顶部挂 CORS**

在 `createApp` 内、挂路由前加：

```ts
import { cors } from "hono/cors"
import { env } from "./config/env"
// ... 在 createApp 内：
  const allow = env.WEB_ORIGINS.split(",").map((s) => s.trim())
  app.use(
    "*",
    cors({
      origin: (o) => (allow.includes(o) ? o : allow[0]!),
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      credentials: true,
    }),
  )
```

- [ ] **Step 4: 冒烟：预检 + 带 Origin 的请求**

```bash
cd apps/api && bun run api & sleep 2
curl -s -i -X OPTIONS localhost:8080/auth/sms/send -H 'Origin: http://localhost:3000' -H 'Access-Control-Request-Method: POST' | grep -i access-control-allow-origin
kill %1
```
Expected: 响应含 `Access-Control-Allow-Origin: http://localhost:3000`。

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/app.ts apps/api/src/config/env.ts
git commit -m "feat(spec005): App API CORS 放行 web 源

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: token-store（可注入存储）+ 单测

**Files:**
- Create: `apps/web/lib/token-store.ts`、`apps/web/test/token-store.test.ts`
- Modify: `apps/web/package.json`（加 `"test": "bun test"`）

- [ ] **Step 1: 写失败测试 `apps/web/test/token-store.test.ts`**

```ts
import { describe, it, expect } from "bun:test"
import { createTokenStore } from "../lib/token-store"

function memStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  }
}

describe("token-store", () => {
  it("set/get/clear", () => {
    const s = createTokenStore(memStorage())
    expect(s.get()).toBeNull()
    s.set("tok-123")
    expect(s.get()).toBe("tok-123")
    s.clear()
    expect(s.get()).toBeNull()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/web && bun test test/token-store.test.ts`
Expected: FAIL（`createTokenStore` 不存在）。

- [ ] **Step 3: 写 `apps/web/lib/token-store.ts`**

```ts
export type SimpleStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const KEY = "bid.token"

export function createTokenStore(storage: SimpleStorage) {
  return {
    get: (): string | null => storage.getItem(KEY),
    set: (token: string): void => storage.setItem(KEY, token),
    clear: (): void => storage.removeItem(KEY),
  }
}

// 浏览器用 localStorage；SSR/缺失时退化为内存（避免 import 期崩）
function safeStorage(): SimpleStorage {
  if (typeof window !== "undefined" && window.localStorage) return window.localStorage
  const m = new Map<string, string>()
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  }
}

export const tokenStore = createTokenStore(safeStorage())
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/web && bun test test/token-store.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/web/lib/token-store.ts apps/web/test/token-store.test.ts apps/web/package.json
git commit -m "feat(spec005): token-store(可注入存储) + 单测

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: api-client（注入 fetch/token）+ 单测

**Files:**
- Create: `apps/web/lib/api-client.ts`、`apps/web/test/api-client.test.ts`

- [ ] **Step 1: 写失败测试 `apps/web/test/api-client.test.ts`**

```ts
import { describe, it, expect } from "bun:test"
import { createApiClient, ApiError } from "../lib/api-client"

function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  return async (url: string | URL | Request, init?: RequestInit) => {
    const { status, body } = handler(String(url), init)
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  }
}

describe("api-client", () => {
  it("verifySmsCode 成功返回 token + user，并带上 Content-Type", async () => {
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
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/web && bun test test/api-client.test.ts`
Expected: FAIL（`createApiClient` 不存在）。

- [ ] **Step 3: 写 `apps/web/lib/api-client.ts`**

```ts
export class ApiError extends Error {
  constructor(
    public status: number,
    public code?: string,
    public retryAfter?: number,
  ) {
    super(`API ${status}${code ? " " + code : ""}`)
  }
}

export type ApiClientOptions = {
  baseUrl: string
  getToken: () => string | null
  fetchImpl?: typeof fetch
}

export function createApiClient(opts: ApiClientOptions) {
  const doFetch = opts.fetchImpl ?? fetch

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers)
    if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json")
    const token = opts.getToken()
    if (token) headers.set("authorization", `Bearer ${token}`)
    const res = await doFetch(`${opts.baseUrl}${path}`, { ...init, headers })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new ApiError(res.status, (body as any)?.error, (body as any)?.retryAfter)
    }
    return body as T
  }

  const post = <T>(path: string, data: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(data) })

  const authApi = {
    sendSmsCode: (phone: string, captchaToken?: string) =>
      post<{ ok: true }>("/auth/sms/send", { phone, captchaToken }).then(() => undefined),
    verifySmsCode: (phone: string, code: string, agreedToTerms?: boolean) =>
      post<{ token: string; isNew: boolean; user: { id: string; nickname: string | null } }>(
        "/auth/sms/verify",
        { phone, code, agreedToTerms },
      ),
    me: () => request<{ id: string; nickname: string | null; status: string }>("/auth/me"),
    logout: () => post<{ ok: true }>("/auth/logout", {}).then(() => undefined),
  }

  return { request, authApi }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/web && bun test test/api-client.test.ts`
Expected: PASS（3 项）。

- [ ] **Step 5: 提交**

```bash
git add apps/web/lib/api-client.ts apps/web/test/api-client.test.ts
git commit -m "feat(spec005): api-client(注入 fetch/token + ApiError) + 单测

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: AuthProvider/useAuth + 默认客户端单例 + 接入 /login

**Files:**
- Create: `apps/web/lib/api.ts`（默认客户端单例）、`apps/web/components/auth/auth-provider.tsx`、`apps/web/.env.local`
- Modify: `apps/web/app/login/page.tsx`、`apps/web/app/layout.tsx`（包 Provider）

- [ ] **Step 1: 写默认客户端单例 `apps/web/lib/api.ts`**

```ts
import { createApiClient } from "./api-client"
import { tokenStore } from "./token-store"

const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080"
export const api = createApiClient({ baseUrl, getToken: () => tokenStore.get() })
export const captchaEnabled = process.env.NEXT_PUBLIC_CAPTCHA_ENABLED === "true"
```

- [ ] **Step 2: 写 `apps/web/.env.local`（不入库；确认被 .gitignore 的 `.env*.local` 覆盖）**

```bash
cat > apps/web/.env.local <<'EOF'
NEXT_PUBLIC_API_BASE_URL=http://localhost:8080
NEXT_PUBLIC_CAPTCHA_ENABLED=false
EOF
git check-ignore apps/web/.env.local   # 期望输出该路径（被忽略）
```

- [ ] **Step 3: 写 `apps/web/components/auth/auth-provider.tsx`**

```tsx
"use client"
import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import { api } from "@/lib/api"
import { tokenStore } from "@/lib/token-store"

type User = { id: string; nickname: string | null; status?: string }
type AuthCtx = {
  user: User | null
  loading: boolean
  login: (token: string, user: User) => void
  logout: () => Promise<void>
  refresh: () => Promise<void>
}

const Ctx = createContext<AuthCtx | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  async function refresh() {
    if (!tokenStore.get()) { setUser(null); setLoading(false); return }
    try { setUser(await api.authApi.me()) } catch { tokenStore.clear(); setUser(null) }
    finally { setLoading(false) }
  }
  useEffect(() => { void refresh() }, [])

  const login = (token: string, u: User) => { tokenStore.set(token); setUser(u) }
  const logout = async () => { try { await api.authApi.logout() } finally { tokenStore.clear(); setUser(null) } }

  return <Ctx.Provider value={{ user, loading, login, logout, refresh }}>{children}</Ctx.Provider>
}

export function useAuth() {
  const v = useContext(Ctx)
  if (!v) throw new Error("useAuth 必须在 <AuthProvider> 内使用")
  return v
}
```

- [ ] **Step 4: 在 `apps/web/app/layout.tsx` 用 `<AuthProvider>` 包裹 children**

在根 layout 的 body 内层包一层 `<AuthProvider>{children}</AuthProvider>`（保留现有 Provider/样式结构）。

- [ ] **Step 5: 接入 `apps/web/app/login/page.tsx`（替换 mock）**

读现有 `/login` 页，把"发送验证码""登录"两处 mock 处理函数替换为真实调用（保留原 UI/输入框/状态）。核心处理逻辑：

```tsx
// 顶部
"use client"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { api, captchaEnabled } from "@/lib/api"
import { useAuth } from "@/components/auth/auth-provider"
import { ApiError } from "@/lib/api-client"

// 组件内（接到现有"发送验证码"按钮 onClick）
async function handleSendCode(phone: string, setMsg: (s: string) => void) {
  try {
    // captchaEnabled 时这里应带滑块 token（spec004.1）；dev 默认 false，不带
    await api.authApi.sendSmsCode(phone, captchaEnabled ? "" : undefined)
    setMsg("验证码已发送")
  } catch (e) {
    if (e instanceof ApiError && e.status === 429) setMsg(`操作过于频繁，请 ${e.retryAfter ?? 60}s 后重试`)
    else setMsg("发送失败，请稍后重试")
  }
}

// 组件内（接到现有"登录"按钮 onClick）；login/router 来自 useAuth()/useRouter()
// agreed = 协议同意勾选框的 state（见 Step 5b）
async function handleLogin(
  phone: string, code: string, agreed: boolean,
  login: (t: string, u: { id: string; nickname: string | null }) => void,
  go: () => void, setMsg: (s: string) => void,
) {
  if (!agreed) { setMsg("请先阅读并同意《用户协议》和《隐私政策》"); return }
  try {
    const { token, user, isNew } = await api.authApi.verifySmsCode(phone, code, agreed)
    login(token, user)
    go() // 例如 router.push(isNew ? "/onboarding" : "/projects")（新用户可走欢迎/注册赠送流程）
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) setMsg("验证码错误或已过期")
    else if (e instanceof ApiError && e.status === 400) setMsg("请先同意协议后再登录")
    else setMsg("登录失败")
  }
}
```

- [ ] **Step 5b: 登录页加"协议同意"勾选框（合规必备）**

在 `/login` 表单底部、登录按钮上方加一个受控勾选框（用现有 UI 组件，如 shadcn `Checkbox`），绑定 `const [agreed, setAgreed] = useState(false)`，并把 `agreed` 传入 `handleLogin`：

```tsx
<label className="flex items-start gap-2 text-sm text-muted-foreground">
  <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-1" />
  <span>
    我已阅读并同意
    <a href="/legal/terms" className="text-primary underline" target="_blank">《用户协议》</a>
    与
    <a href="/legal/privacy" className="text-primary underline" target="_blank">《隐私政策》</a>
  </span>
</label>
```

> 未注册手机号验证通过即自动建号（注册），故登录页双关"登录/注册"，**必须有协议同意**：前端 `agreed=false` 直接拦；后端对新号 `agreedToTerms!==true` 返 `400 terms_required` 兜底。`isNew=true` 可用于跳新手引导/注册赠送（Phase 3）。

- [ ] **Step 6: 端到端冒烟（浏览器）**

```bash
# 终端1：起 API（用真实 env）  终端2：起 web
cd apps/api && bun run api    # :8080
cd apps/web && bun run web    # :3000
```
浏览器开 `http://localhost:3000/login`：输手机号 → 点发送（API 终端 `[FakeSMS]` 打印验证码）→ 输该码 → 登录 → 跳转到登录后页面；刷新后仍登录（`/auth/me` 还原）。
> 清理冒烟用户同 spec004 Task 5。

- [ ] **Step 7: 提交**

```bash
git add apps/web/lib/api.ts apps/web/components/auth apps/web/app/login/page.tsx apps/web/app/layout.tsx
git commit -m "feat(spec005): AuthProvider/useAuth + /login 接真实 /auth

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 路由守卫 + 保护页 + 合并

**Files:**
- Create: `apps/web/components/auth/require-auth.tsx`
- Modify: 受保护页面（如 `app/(tool)/projects/page.tsx` 等）外层包守卫，或在分组 layout 包一次

- [ ] **Step 1: 写 `apps/web/components/auth/require-auth.tsx`**

```tsx
"use client"
import { useEffect, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "./auth-provider"

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth()
  const router = useRouter()
  useEffect(() => {
    if (!loading && !user) router.replace("/login")
  }, [loading, user, router])
  if (loading) return null
  if (!user) return null
  return <>{children}</>
}
```

- [ ] **Step 2: 在工具区分组 layout 包守卫**

在 `apps/web/app/(tool)/layout.tsx`（若无则新建该分组 layout）用 `<RequireAuth>` 包裹 children，使 `/upload /read /outline /content /risk /present /projects /library /membership` 等需登录。

- [ ] **Step 3: 守卫冒烟**

未登录直接访问 `http://localhost:3000/projects` → 自动跳 `/login`；登录后可正常访问；登出后再访问又跳回 `/login`。

- [ ] **Step 4: 全量校验**

Run: `cd apps/web && bun test && bun run build`
Expected: lib 单测全过；`next build` 成功（无类型错误）。

- [ ] **Step 5: 提交并合并**

```bash
git add apps/web/components/auth/require-auth.tsx "apps/web/app/(tool)/layout.tsx"
git commit -m "feat(spec005): RequireAuth 路由守卫 + 工具区分组保护

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git checkout main
git merge --no-ff phase0/spec005-web-login -m "merge spec005: 前端接入登录"
git push origin main
```

---

## 验收清单（spec005 完成判据）

- [ ] App API 已加 CORS，预检返回正确 `Access-Control-Allow-Origin`。
- [ ] `token-store`、`api-client` 注入式可单测，`bun test` 全过（含 Bearer 携带、ApiError 解析）。
- [ ] `/login` 端到端：发码（dev 控制台打印）→ 输码 → 登录 → 跳转；刷新仍登录（`/auth/me` 还原）。
- [ ] 429 文案提示重试秒数；401 提示验证码错误。
- [ ] 未登录访问受保护页跳 `/login`；登出后失效。
- [ ] `NEXT_PUBLIC_CAPTCHA_ENABLED=false` 时不出滑块、发码不带 token（DevPass 放行）；真实滑块 = spec004.1。
- [ ] `apps/web/.env.local` 未入库；`bun run build` 成功。
