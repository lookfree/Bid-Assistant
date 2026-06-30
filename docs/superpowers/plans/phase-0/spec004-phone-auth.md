# spec004 · 手机号验证码鉴权 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 C 端手机号验证码登录全链路：阿里云短信发码（开发期可用 Fake sender）、Redis 存码 + 限流、验证码校验 → 找/建用户（spec003 身份模型）→ 签发**不透明会话令牌**（Bearer，落 `sessions` 可撤销）、`/auth/*` 接口与鉴权中间件。

**Architecture:** 短信发送抽象成 `SmsSender`（Aliyun 实现 + Fake 实现，按凭据有无切换）；验证码服务用 Redis（库 3、前缀 `bid:`）存码与限流；登录成功生成随机令牌，DB 只存其 sha256 哈希（`sessions.tokenHash`），每次请求经鉴权中间件查 `findValidSession` 还原用户。依赖注入便于单测。

**Tech Stack:** Hono、ioredis（纯 JS）、`@alicloud/dysmsapi20170525`+`@alicloud/openapi-client`（纯 JS）、Zod、`node:crypto`、`bun:test`。

## Global Constraints

见 `spec000-index.md`。本 spec 关键约束：
- Redis 连接用 host/port/password 分离参数（密码含全角字符，勿拼 URL）；库 `REDIS_DB=3`、前缀 `bid:`。
- 阿里云短信凭据**当前可能缺失** → 凭据齐全用 `AliyunSmsSender`，否则用 `FakeSmsSender`（console 打印验证码，仅开发）。
- **防刷默认姿态：滑块（人机验证）默认开启；限频四层（同号冷却 / 同号限频 / 同 IP 限频 / 校验尝试上限）默认关闭、可逐层开。** 滑块无凭据时开发期 DevPass、生产 fail-closed。
- 令牌为不透明随机串；DB 只存 sha256 哈希；登录态可撤销（`sessions`）。
- 钱的唯一权威是 App API（本 spec 不涉及计费）。
- 集成测试连真库/真 Redis（bidsaas），`--env-file=../../.env.bidsaas.local`，自清理。
- 在 `main` 上先开分支再改；提交信息结尾附 Co-Authored-By。

---

## File Structure

```
apps/api/
├── src/
│   ├── config/env.ts                 # 改：补 REDIS_* / ALIYUN_SMS_* / AUTH_SESSION_TTL_DAYS
│   ├── redis/client.ts               # 新：ioredis 实例（库3+前缀）
│   ├── services/
│   │   ├── sms-sender.ts             # 新：SmsSender 接口 + Aliyun/Fake + 工厂
│   │   ├── sms-code.ts               # 新：发码限流 + 校验（注入 redis+sender）
│   │   └── auth.ts                   # 新：hashToken / loginWithPhone / resolveUserFromToken / logout
│   ├── middleware/auth.ts            # 新：Bearer 鉴权中间件
│   ├── routes/auth.ts                # 新：/sms/send /sms/verify /me /logout
│   └── app.ts                        # 改：deps 注入 smsCode，挂载 /auth
│   └── index.ts                      # 改：构造真实 deps（redis/sender/smsCode）
└── test/
    ├── services/sms-code.test.ts     # 新：集成（真 Redis）
    └── routes/auth.test.ts           # 新：集成（fake smsCode + 真 DB）
```

---

## Interfaces（本 spec 对外产出，供 spec005 依赖）

- Produces：
  - 类型 `SmsCodeService = { request(input: { phone: string; ip?: string }): Promise<{ ok: true } | { ok: false; reason: "cooldown" | "rate_limited"; retryAfter?: number }>; verify(phone: string, code: string): Promise<boolean> }`（多层防刷见 Task 3）
  - HTTP 契约（`apps/web` spec005 调用）：
    - `POST /auth/sms/send` body `{ phone, captchaToken? }` → `200 { ok: true }` / `429 { error:"too_many_requests", retryAfter? }`（冷却或限频）/ `403 { error:"captcha_required" }`（开启人机验证且未过）/ `400 { error }`
    - `POST /auth/sms/verify` body `{ phone, code, agreedToTerms? }` → `200 { token, isNew, user: { id, nickname } }` / `401 { error:"invalid_code" }` / `400 { error:"terms_required" }`（未注册手机号自动建号，**首次需 `agreedToTerms:true`**；`isNew` 标识是否首次建号）
    - `GET /auth/me`（Bearer）→ `200 { id, nickname, status }` / `401`
    - `POST /auth/logout`（Bearer）→ `200 { ok: true }`
  - `authMiddleware`（Hono）：校验 `Authorization: Bearer <token>`，成功把 `User` 放入 `c.var.user`，否则 401。
  - `createApp(deps)` 扩展：`deps.smsCode?` 存在时挂载 `/auth`。

---

## Task 1: env 扩展 + Redis 客户端

**Files:**
- Modify: `apps/api/src/config/env.ts`、`apps/api/package.json`
- Create: `apps/api/src/redis/client.ts`、`apps/api/test/redis.smoke.test.ts`

- [ ] **Step 1: 开分支 + 装依赖**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout -b phase0/spec004-phone-auth
cd apps/api && bun add ioredis @alicloud/dysmsapi20170525 @alicloud/openapi-client
```

- [ ] **Step 2: 扩展 `apps/api/src/config/env.ts` 的 schema**

先在 `env.ts` 顶部（`import` 之后、`schema` 之前）加布尔解析辅助——注意 **不能用 `z.coerce.boolean()`**（它把字符串 `"false"` 也判为 true）：

```ts
const envBool = (def: boolean) =>
  z.preprocess(
    (v) => (typeof v === "string" ? ["1", "true", "yes", "on"].includes(v.toLowerCase()) : v),
    z.boolean(),
  ).default(def)
```

再在 `schema` 的 object 内追加字段（保留原 NODE_ENV/PORT/DATABASE_URL）：

```ts
  REDIS_HOST: z.string().default("127.0.0.1"),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.coerce.number().int().min(0).default(3),
  REDIS_KEY_PREFIX: z.string().default("bid:"),
  ALIYUN_SMS_ACCESS_KEY_ID: z.string().optional(),
  ALIYUN_SMS_ACCESS_KEY_SECRET: z.string().optional(),
  ALIYUN_SMS_SIGN_NAME: z.string().optional(),
  ALIYUN_SMS_TEMPLATE_CODE: z.string().optional(),
  AUTH_SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  // —— 人机验证（滑块）：默认开启 ——
  CAPTCHA_ENABLED: envBool(true),
  ALIYUN_CAPTCHA_ACCESS_KEY_ID: z.string().optional(),
  ALIYUN_CAPTCHA_ACCESS_KEY_SECRET: z.string().optional(),
  ALIYUN_CAPTCHA_SCENE_ID: z.string().optional(),
  // —— 限频类防刷：各层独立开关，默认关闭（按需开启）；阈值仍可配 ——
  SMS_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  SMS_COOLDOWN_ENABLED: envBool(false),
  SMS_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),
  SMS_PHONE_LIMIT_ENABLED: envBool(false),
  SMS_MAX_PER_PHONE_HOUR: z.coerce.number().int().positive().default(5),
  SMS_MAX_PER_PHONE_DAY: z.coerce.number().int().positive().default(10),
  SMS_IP_LIMIT_ENABLED: envBool(false),
  SMS_MAX_PER_IP_HOUR: z.coerce.number().int().positive().default(20),
  SMS_MAX_PER_IP_DAY: z.coerce.number().int().positive().default(50),
  SMS_ATTEMPT_LIMIT_ENABLED: envBool(false),
  SMS_MAX_VERIFY_ATTEMPTS: z.coerce.number().int().positive().default(5),
```

- [ ] **Step 3: 写 `apps/api/src/redis/client.ts`**

```ts
import Redis from "ioredis"
import { env } from "../config/env"

export const redis = new Redis({
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD,
  db: env.REDIS_DB,
  keyPrefix: env.REDIS_KEY_PREFIX,
  maxRetriesPerRequest: 2,
})
```

- [ ] **Step 4: 写 Redis 冒烟测试 `apps/api/test/redis.smoke.test.ts`**

```ts
import { describe, it, expect, afterAll } from "bun:test"
import { redis } from "../src/redis/client"

afterAll(() => redis.disconnect())

describe("redis", () => {
  it("set/get/del roundtrip on db3", async () => {
    const k = `smoke:${Date.now()}`
    await redis.set(k, "v", "EX", 10)
    expect(await redis.get(k)).toBe("v")
    await redis.del(k)
    expect(await redis.get(k)).toBeNull()
  })
})
```

- [ ] **Step 5: 运行冒烟（连真 Redis）**

Run: `cd apps/api && bun --env-file=../../.env.bidsaas.local test test/redis.smoke.test.ts`
Expected: PASS（连通 bidsaas Redis 库3）。

- [ ] **Step 6: 提交**

```bash
git add apps/api/src/config/env.ts apps/api/src/redis apps/api/test/redis.smoke.test.ts apps/api/package.json
git commit -m "feat(spec004): env 扩展(Redis/SMS) + ioredis 客户端

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: SmsSender 抽象（Aliyun + Fake + 工厂）

**Files:**
- Create: `apps/api/src/services/sms-sender.ts`

- [ ] **Step 1: 写 `apps/api/src/services/sms-sender.ts`**

```ts
import Dysmsapi from "@alicloud/dysmsapi20170525"
import { SendSmsRequest } from "@alicloud/dysmsapi20170525"
import { Config as OpenApiConfig } from "@alicloud/openapi-client"
import type { Env } from "../config/env"

export interface SmsSender {
  send(phone: string, code: string): Promise<void>
}

/** 开发期：不真发短信，打印到控制台 */
export class FakeSmsSender implements SmsSender {
  async send(phone: string, code: string): Promise<void> {
    console.log(`[FakeSMS] -> ${phone} 验证码 ${code}`)
  }
}

export class AliyunSmsSender implements SmsSender {
  private client: Dysmsapi
  constructor(
    private cfg: { accessKeyId: string; accessKeySecret: string; signName: string; templateCode: string },
  ) {
    this.client = new Dysmsapi(
      new OpenApiConfig({
        accessKeyId: cfg.accessKeyId,
        accessKeySecret: cfg.accessKeySecret,
        endpoint: "dysmsapi.aliyuncs.com",
      }),
    )
  }
  async send(phone: string, code: string): Promise<void> {
    const req = new SendSmsRequest({
      phoneNumbers: phone.replace(/^\+86/, ""),
      signName: this.cfg.signName,
      templateCode: this.cfg.templateCode,
      templateParam: JSON.stringify({ code }),
    })
    const res = await this.client.sendSms(req)
    if (res.body?.code !== "OK") {
      throw new Error(`阿里云短信发送失败: ${res.body?.code} ${res.body?.message}`)
    }
  }
}

export function createSmsSender(env: Env): SmsSender {
  const { ALIYUN_SMS_ACCESS_KEY_ID, ALIYUN_SMS_ACCESS_KEY_SECRET, ALIYUN_SMS_SIGN_NAME, ALIYUN_SMS_TEMPLATE_CODE } = env
  if (ALIYUN_SMS_ACCESS_KEY_ID && ALIYUN_SMS_ACCESS_KEY_SECRET && ALIYUN_SMS_SIGN_NAME && ALIYUN_SMS_TEMPLATE_CODE) {
    return new AliyunSmsSender({
      accessKeyId: ALIYUN_SMS_ACCESS_KEY_ID,
      accessKeySecret: ALIYUN_SMS_ACCESS_KEY_SECRET,
      signName: ALIYUN_SMS_SIGN_NAME,
      templateCode: ALIYUN_SMS_TEMPLATE_CODE,
    })
  }
  console.warn("[sms] 阿里云短信凭据缺失，使用 FakeSmsSender（仅开发期）")
  return new FakeSmsSender()
}
```

- [ ] **Step 2: 类型检查**

Run: `cd apps/api && bun run typecheck`
Expected: 通过（阿里云 SDK 类型解析正常）。

- [ ] **Step 3: 提交**

```bash
git add apps/api/src/services/sms-sender.ts
git commit -m "feat(spec004): SmsSender 抽象(Aliyun + Fake + 工厂)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 验证码服务（多层防刷 + 一次性校验）—— TDD

**防刷分层**：① 同号冷却 60s；② 同号时/日限频；③ 同 IP 时/日限频（防一 IP 刷多号）；④ 单码校验尝试上限（防暴力猜码，超次作废）。阈值全配置化（env，Task 1）。人机验证（滑块/行为）在路由层挂钩（Task 4）。

**Files:**
- Create: `apps/api/src/services/sms-code.ts`、`apps/api/test/services/sms-code.test.ts`

**Interfaces:**
- Produces: `makeSmsCodeService(redis, sender, limits): SmsCodeService`；`SmsLimits`、`SmsRequestInput = { phone; ip? }`、`SmsRequestResult`。

- [ ] **Step 1: 写失败测试 `apps/api/test/services/sms-code.test.ts`**

```ts
import { describe, it, expect, afterAll } from "bun:test"
import { makeSmsCodeService, type SmsLimits } from "../../src/services/sms-code"
import { redis } from "../../src/redis/client"
import type { SmsSender } from "../../src/services/sms-sender"

afterAll(() => redis.disconnect())

class CapturingSender implements SmsSender {
  last: { phone: string; code: string } | null = null
  async send(phone: string, code: string) { this.last = { phone, code } }
}

// 默认全关；各测试只开自己要验证的那层
const mk = (o: Partial<SmsLimits> = {}): SmsLimits => ({
  codeTtl: 300,
  cooldownEnabled: false, cooldown: 60,
  phoneLimitEnabled: false, phoneHour: 5, phoneDay: 10,
  ipLimitEnabled: false, ipHour: 20, ipDay: 50,
  attemptLimitEnabled: false, maxAttempts: 5,
  ...o,
})
const newPhone = () => `+8613${(Date.now() + Math.floor(Math.random() * 1e6)).toString().slice(-9)}`

describe("sms-code 防刷", () => {
  it("request -> 6 位码; verify 一次性消费", async () => {
    const sender = new CapturingSender()
    const svc = makeSmsCodeService(redis, sender, mk())
    const phone = newPhone()
    expect((await svc.request({ phone })).ok).toBe(true)
    expect(sender.last?.code).toMatch(/^\d{6}$/)
    expect(await svc.verify(phone, sender.last!.code)).toBe(true)
    expect(await svc.verify(phone, sender.last!.code)).toBe(false) // 已消费
  })

  it("各层默认关闭：立即重发仍 OK（无冷却）", async () => {
    const svc = makeSmsCodeService(redis, new CapturingSender(), mk())
    const phone = newPhone()
    expect((await svc.request({ phone })).ok).toBe(true)
    expect((await svc.request({ phone })).ok).toBe(true) // 冷却关 -> 仍允许
    await redis.del(`sms:code:${phone}`)
  })

  it("开启冷却：立即重发 -> reason cooldown + retryAfter", async () => {
    const svc = makeSmsCodeService(redis, new CapturingSender(), mk({ cooldownEnabled: true }))
    const phone = newPhone()
    await svc.request({ phone })
    const r = await svc.request({ phone })
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.reason).toBe("cooldown"); expect(r.retryAfter).toBeGreaterThan(0) }
    await redis.del(`sms:code:${phone}`, `sms:cd:${phone}`)
  })

  it("开启同号限频：触顶 -> rate_limited", async () => {
    const svc = makeSmsCodeService(redis, new CapturingSender(), mk({ phoneLimitEnabled: true, phoneHour: 2 }))
    const phone = newPhone()
    await redis.set(`sms:ph:1h:${phone}`, "2", "EX", 3600) // 预置到上限
    const r = await svc.request({ phone })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("rate_limited")
    await redis.del(`sms:ph:1h:${phone}`)
  })

  it("开启同 IP 限频：触顶 -> rate_limited", async () => {
    const svc = makeSmsCodeService(redis, new CapturingSender(), mk({ ipLimitEnabled: true, ipHour: 2 }))
    const ip = `203.0.113.${Math.floor(Math.random() * 255)}`
    await redis.set(`sms:ip:1h:${ip}`, "2", "EX", 3600)
    const r = await svc.request({ phone: newPhone(), ip })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("rate_limited")
    await redis.del(`sms:ip:1h:${ip}`)
  })

  it("开启尝试上限：超次后验证码作废", async () => {
    const sender = new CapturingSender()
    const svc = makeSmsCodeService(redis, sender, mk({ attemptLimitEnabled: true, maxAttempts: 2 }))
    const phone = newPhone()
    await svc.request({ phone })
    const correct = sender.last!.code
    expect(await svc.verify(phone, "000000")).toBe(false) // 第 1 次
    expect(await svc.verify(phone, "000000")).toBe(false) // 第 2 次
    expect(await svc.verify(phone, correct)).toBe(false)   // 第 3 次 > 2 -> 作废
  })
})
```

> 注：`redis` 带 `keyPrefix=bid:`，键 `sms:cd:..` 实际为 `bid:sms:cd:..`。

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/api && bun --env-file=../../.env.bidsaas.local test test/services/sms-code.test.ts`
Expected: FAIL（`makeSmsCodeService` 不存在 / 签名不符）。

- [ ] **Step 3: 写 `apps/api/src/services/sms-code.ts`**

```ts
import { randomInt } from "node:crypto"
import type { Redis } from "ioredis"
import type { SmsSender } from "./sms-sender"

export type SmsLimits = {
  codeTtl: number
  cooldownEnabled: boolean
  cooldown: number
  phoneLimitEnabled: boolean
  phoneHour: number
  phoneDay: number
  ipLimitEnabled: boolean
  ipHour: number
  ipDay: number
  attemptLimitEnabled: boolean
  maxAttempts: number
}
export type SmsRequestInput = { phone: string; ip?: string }
export type SmsRequestResult =
  | { ok: true }
  | { ok: false; reason: "cooldown" | "rate_limited"; retryAfter?: number }

export type SmsCodeService = {
  request(input: SmsRequestInput): Promise<SmsRequestResult>
  verify(phone: string, code: string): Promise<boolean>
}

export function makeSmsCodeService(redis: Redis, sender: SmsSender, limits: SmsLimits): SmsCodeService {
  // 固定窗口计数：首次自增时设过期
  const bump = async (key: string, win: number): Promise<number> => {
    const n = await redis.incr(key)
    if (n === 1) await redis.expire(key, win)
    return n
  }

  return {
    async request({ phone, ip }) {
      const cd = `sms:cd:${phone}`
      // ① 同号冷却（可关）
      if (limits.cooldownEnabled) {
        const ttl = await redis.ttl(cd)
        if (ttl > 0) return { ok: false, reason: "cooldown", retryAfter: ttl }
      }

      // ②③ 同号 / 同 IP 时·日限频（各自可关；先读判，未触顶才发）
      const windows: Array<{ key: string; cap: number; win: number }> = []
      if (limits.phoneLimitEnabled) {
        windows.push(
          { key: `sms:ph:1h:${phone}`, cap: limits.phoneHour, win: 3600 },
          { key: `sms:ph:1d:${phone}`, cap: limits.phoneDay, win: 86400 },
        )
      }
      if (limits.ipLimitEnabled && ip) {
        windows.push(
          { key: `sms:ip:1h:${ip}`, cap: limits.ipHour, win: 3600 },
          { key: `sms:ip:1d:${ip}`, cap: limits.ipDay, win: 86400 },
        )
      }
      for (const w of windows) {
        if (Number((await redis.get(w.key)) ?? 0) >= w.cap) return { ok: false, reason: "rate_limited" }
      }

      const code = String(randomInt(100000, 1000000))
      await redis.set(`sms:code:${phone}`, code, "EX", limits.codeTtl)
      await redis.del(`sms:att:${phone}`) // 重置尝试计数
      if (limits.cooldownEnabled) await redis.set(cd, "1", "EX", limits.cooldown)
      for (const w of windows) await bump(w.key, w.win)
      await sender.send(phone, code)
      return { ok: true }
    },

    async verify(phone, code) {
      const codeKey = `sms:code:${phone}`
      const stored = await redis.get(codeKey)
      if (!stored) return false
      // ④ 尝试上限（可关）：超次作废
      if (limits.attemptLimitEnabled) {
        const attempts = await bump(`sms:att:${phone}`, limits.codeTtl)
        if (attempts > limits.maxAttempts) {
          await redis.del(codeKey, `sms:att:${phone}`)
          return false
        }
      }
      if (stored === code) {
        await redis.del(codeKey, `sms:att:${phone}`)
        return true
      }
      return false
    },
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/api && bun --env-file=../../.env.bidsaas.local test test/services/sms-code.test.ts`
Expected: PASS（6 项）。

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/services/sms-code.ts apps/api/test/services/sms-code.test.ts
git commit -m "feat(spec004): 验证码多层防刷(冷却/号·IP限频/尝试上限) + 集成测试

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 登录服务 + 鉴权中间件 + /auth 路由 —— TDD

**Files:**
- Create: `apps/api/src/services/auth.ts`、`apps/api/src/services/captcha.ts`、`apps/api/src/middleware/auth.ts`、`apps/api/src/routes/auth.ts`、`apps/api/test/routes/auth.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: spec003 仓储；Task 3 的 `SmsCodeService`。
- Produces: `/auth/*`、`authMiddleware`、`createApp` 挂载 auth。

- [ ] **Step 1: 写 `apps/api/src/services/auth.ts`**

```ts
import { randomBytes, createHash } from "node:crypto"
import { findUserByIdentity, createUserWithIdentity, getUserById } from "../repos/users"
import { createSession, findValidSession, revokeSession } from "../repos/sessions"
import type { User } from "../db/schema"

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/** 未注册手机号需先同意协议才会自动建号；否则拒绝。 */
export class TermsRequiredError extends Error {
  constructor() {
    super("terms_required")
  }
}

export async function loginWithPhone(
  phone: string,
  meta: { userAgent?: string; ip?: string; agreedToTerms?: boolean },
  ttlDays: number,
): Promise<{ token: string; user: User; isNew: boolean }> {
  let user = await findUserByIdentity("phone", phone)
  let isNew = false
  if (!user) {
    // 验证码登录即注册：首次必须带协议同意
    if (!meta.agreedToTerms) throw new TermsRequiredError()
    user = await createUserWithIdentity({
      provider: "phone",
      identifier: phone,
      verifiedAt: new Date(),
      termsAgreedAt: new Date(),
    })
    isNew = true
  }
  const token = randomBytes(32).toString("hex")
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000)
  await createSession({ userId: user.id, tokenHash: hashToken(token), expiresAt, userAgent: meta.userAgent, ip: meta.ip })
  return { token, user, isNew }
}

export async function resolveUserFromToken(token: string): Promise<User | null> {
  const session = await findValidSession(hashToken(token))
  if (!session) return null
  return getUserById(session.userId)
}

export async function logout(token: string): Promise<void> {
  const session = await findValidSession(hashToken(token))
  if (session) await revokeSession(session.id)
}
```

- [ ] **Step 2: 写 `apps/api/src/middleware/auth.ts`**

```ts
import { createMiddleware } from "hono/factory"
import { resolveUserFromToken } from "../services/auth"
import type { User } from "../db/schema"

export const authMiddleware = createMiddleware<{ Variables: { user: User } }>(async (c, next) => {
  const header = c.req.header("Authorization") ?? ""
  const token = header.startsWith("Bearer ") ? header.slice(7) : ""
  const user = token ? await resolveUserFromToken(token) : null
  if (!user) return c.json({ error: "unauthorized" }, 401)
  c.set("user", user)
  await next()
})
```

- [ ] **Step 3a: 写人机验证（滑块）钩子 `apps/api/src/services/captcha.ts`**

> 设计：**滑块默认开启**（`CAPTCHA_ENABLED=true`）。校验器按凭据/环境三态：
> ① 阿里云滑块凭据齐全 → `AliyunSliderCaptchaVerifier`（真校验 token）；
> ② 凭据缺失 + 非生产 → `DevPassCaptchaVerifier`（放行 + 告警，便于本地开发）；
> ③ 凭据缺失 + 生产 + 已开启 → **启动即抛错**（fail-closed，绝不在生产静默放行）。

```ts
import type { Env } from "../config/env"

export interface CaptchaVerifier {
  verify(token?: string): Promise<boolean>
}

/** 开发期放行：凭据缺失时用，恒通过（仅非生产）。 */
export class DevPassCaptchaVerifier implements CaptchaVerifier {
  async verify(): Promise<boolean> {
    return true
  }
}

/**
 * 工厂（三态）：
 *  - 有阿里云验证码凭据 → 返回真实滑块校验器（spec004.1 接入 @alicloud/captcha20230305 后在此分支返回）。
 *  - 无凭据 + 生产 + 已开启 → 抛错（fail-closed，绝不在生产静默放行）。
 *  - 无凭据 + 非生产 → DevPass（放行 + 告警）。
 */
export function createCaptchaVerifier(env: Env): CaptchaVerifier {
  const hasCreds =
    !!env.ALIYUN_CAPTCHA_ACCESS_KEY_ID && !!env.ALIYUN_CAPTCHA_ACCESS_KEY_SECRET && !!env.ALIYUN_CAPTCHA_SCENE_ID
  if (hasCreds) {
    throw new Error(
      "[captcha] 已配置阿里云验证码凭据，但真实滑块校验器尚未接入——见 spec004.1（接入 @alicloud/captcha20230305 VerifyIntelligentCaptcha）",
    )
  }
  if (env.CAPTCHA_ENABLED && env.NODE_ENV === "production") {
    throw new Error("[captcha] 生产已开启滑块但缺少阿里云验证码凭据——拒绝静默放行，请配置或显式关闭 CAPTCHA_ENABLED")
  }
  console.warn("[captcha] 无滑块凭据，开发期放行（DevPass）；生产前请按 spec004.1 接入阿里云验证码2.0")
  return new DevPassCaptchaVerifier()
}
```

> **范围说明**：本 spec 只交付校验器**接口 + DevPass + 三态工厂 + 生产 fail-closed 守卫**——都是可运行的真实代码。**真实阿里云滑块校验器（`AliyunSliderCaptchaVerifier`）+ 前端滑块组件**拆到独立 **spec004.1**（待阿里云验证码凭据就绪时写，因需 SDK + 凭据 + 前端组件协同）。这样"滑块默认开启"的意图与 fail-closed 安全姿态现在就锁定，且 Phase 0 开发期（无凭据）走 DevPass 不被阻塞。

- [ ] **Step 3b: 写 `apps/api/src/routes/auth.ts`（传 ip + 人机验证门）**

```ts
import { Hono } from "hono"
import { z } from "zod"
import { authMiddleware } from "../middleware/auth"
import { loginWithPhone, logout, TermsRequiredError } from "../services/auth"
import type { SmsCodeService } from "../services/sms-code"

const phoneRe = /^\+?\d{6,15}$/
const sendSchema = z.object({ phone: z.string().regex(phoneRe), captchaToken: z.string().optional() })
const verifySchema = z.object({
  phone: z.string().regex(phoneRe),
  code: z.string().regex(/^\d{6}$/),
  agreedToTerms: z.boolean().optional(), // 首次注册必须为 true
})

export type AuthRouteDeps = {
  smsCode: SmsCodeService
  sessionTtlDays: number
  captchaEnabled: boolean
  verifyCaptcha: (token?: string) => Promise<boolean>
}

export function authRoutes(deps: AuthRouteDeps) {
  const r = new Hono()

  r.post("/sms/send", async (c) => {
    const body = sendSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid_phone" }, 400)
    if (deps.captchaEnabled && !(await deps.verifyCaptcha(body.data.captchaToken))) {
      return c.json({ error: "captcha_required" }, 403)
    }
    const ip = c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() || c.req.header("X-Real-IP")
    const res = await deps.smsCode.request({ phone: body.data.phone, ip })
    if (!res.ok) return c.json({ error: "too_many_requests", reason: res.reason, retryAfter: res.retryAfter }, 429)
    return c.json({ ok: true })
  })

  r.post("/sms/verify", async (c) => {
    const body = verifySchema.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid_input" }, 400)
    const ok = await deps.smsCode.verify(body.data.phone, body.data.code)
    if (!ok) return c.json({ error: "invalid_code" }, 401)
    const ip = c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() || c.req.header("X-Real-IP")
    try {
      const { token, user, isNew } = await loginWithPhone(
        body.data.phone,
        { userAgent: c.req.header("User-Agent"), ip, agreedToTerms: body.data.agreedToTerms },
        deps.sessionTtlDays,
      )
      return c.json({ token, isNew, user: { id: user.id, nickname: user.nickname } })
    } catch (e) {
      if (e instanceof TermsRequiredError) return c.json({ error: "terms_required" }, 400)
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
```

- [ ] **Step 4: 改 `apps/api/src/app.ts` 注入 smsCode 并挂载 /auth**

```ts
import { Hono } from "hono"
import { healthRoutes } from "./routes/health"
import { authRoutes } from "./routes/auth"
import type { SmsCodeService } from "./services/sms-code"

export type AppDeps = {
  pingDb: () => Promise<boolean>
  smsCode?: SmsCodeService
  sessionTtlDays?: number
  captchaEnabled?: boolean
  verifyCaptcha?: (token?: string) => Promise<boolean>
}

export function createApp(deps: AppDeps) {
  const app = new Hono()
  app.route("/", healthRoutes(deps))
  if (deps.smsCode) {
    app.route(
      "/auth",
      authRoutes({
        smsCode: deps.smsCode,
        sessionTtlDays: deps.sessionTtlDays ?? 30,
        captchaEnabled: deps.captchaEnabled ?? false,
        verifyCaptcha: deps.verifyCaptcha ?? (async () => true),
      }),
    )
  }
  return app
}
```

- [ ] **Step 5: 写路由集成测试 `apps/api/test/routes/auth.test.ts`**

```ts
import { describe, it, expect, afterAll } from "bun:test"
import { createApp } from "../../src/app"
import type { SmsCodeService } from "../../src/services/sms-code"
import { findUserByIdentity } from "../../src/repos/users"
import { getDb } from "../../src/db/client"
import { users } from "../../src/db/schema"
import { eq } from "drizzle-orm"

const phone = `+8613${Date.now().toString().slice(-9)}`
const freshPhone = `+8613${(Date.now() + 7).toString().slice(-9)}` // 用于 terms_required（不建号）
const FIXED = "123456"

// 假验证码服务：固定码 123456，便于路由测试不依赖 Redis
const fakeSms: SmsCodeService = {
  async request() { return { ok: true } },
  async verify(_p, code) { return code === FIXED },
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
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone }),
    })
    expect(res.status).toBe(200)
  })

  it("verify with wrong code -> 401", async () => {
    const res = await app.request("/auth/sms/verify", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone, code: "000000" }),
    })
    expect(res.status).toBe(401)
  })

  it("新号未同意协议 -> 400 terms_required", async () => {
    const res = await app.request("/auth/sms/verify", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: freshPhone, code: FIXED }), // 无 agreedToTerms
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("terms_required")
  })

  it("verify(同意协议) -> token + isNew; /me with token -> user; /me without -> 401", async () => {
    const vr = await app.request("/auth/sms/verify", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone, code: FIXED, agreedToTerms: true }),
    })
    expect(vr.status).toBe(200)
    const { token, isNew } = (await vr.json()) as { token: string; isNew: boolean }
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(isNew).toBe(true) // 首次自动建号

    const me = await app.request("/auth/me", { headers: { Authorization: `Bearer ${token}` } })
    expect(me.status).toBe(200)
    const meBody = (await me.json()) as { id: string }
    expect(meBody.id).toBeTruthy()

    const noauth = await app.request("/auth/me")
    expect(noauth.status).toBe(401)

    // logout 后 token 失效
    const lo = await app.request("/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } })
    expect(lo.status).toBe(200)
    const after = await app.request("/auth/me", { headers: { Authorization: `Bearer ${token}` } })
    expect(after.status).toBe(401)
  })
})
```

- [ ] **Step 6: 运行确认通过（真 DB）**

Run: `cd apps/api && bun --env-file=../../.env.bidsaas.local test test/routes/auth.test.ts`
Expected: PASS（send/verify-wrong/verify-login-me-logout 全过，自清理用户）。

- [ ] **Step 7: 提交**

```bash
git add apps/api/src/services/auth.ts apps/api/src/middleware apps/api/src/routes/auth.ts apps/api/src/app.ts apps/api/test/routes/auth.test.ts
git commit -m "feat(spec004): 登录服务 + Bearer 鉴权中间件 + /auth 路由 + 集成测试

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 入口装配真实依赖 + 端到端冒烟 + 合并

**Files:**
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: 改 `apps/api/src/index.ts` 构造真实 deps**

```ts
import { createApp } from "./app"
import { env } from "./config/env"
import { pingDb } from "./db/client"
import { redis } from "./redis/client"
import { createSmsSender } from "./services/sms-sender"
import { makeSmsCodeService, type SmsLimits } from "./services/sms-code"
import { createCaptchaVerifier } from "./services/captcha"

const limits: SmsLimits = {
  codeTtl: env.SMS_CODE_TTL_SECONDS,
  cooldownEnabled: env.SMS_COOLDOWN_ENABLED,
  cooldown: env.SMS_COOLDOWN_SECONDS,
  phoneLimitEnabled: env.SMS_PHONE_LIMIT_ENABLED,
  phoneHour: env.SMS_MAX_PER_PHONE_HOUR,
  phoneDay: env.SMS_MAX_PER_PHONE_DAY,
  ipLimitEnabled: env.SMS_IP_LIMIT_ENABLED,
  ipHour: env.SMS_MAX_PER_IP_HOUR,
  ipDay: env.SMS_MAX_PER_IP_DAY,
  attemptLimitEnabled: env.SMS_ATTEMPT_LIMIT_ENABLED,
  maxAttempts: env.SMS_MAX_VERIFY_ATTEMPTS,
}
const smsCode = makeSmsCodeService(redis, createSmsSender(env), limits)
const captcha = createCaptchaVerifier(env)

const app = createApp({
  pingDb,
  smsCode,
  sessionTtlDays: env.AUTH_SESSION_TTL_DAYS,
  captchaEnabled: env.CAPTCHA_ENABLED,
  verifyCaptcha: (t) => captcha.verify(t),
})

export default { port: env.PORT, fetch: app.fetch }
```

> 默认状态：`CAPTCHA_ENABLED=true`（滑块开），开发期无凭据走 DevPass 放行；限频四层默认关闭。前端在 dev 可不出滑块（spec005 用 `NEXT_PUBLIC_CAPTCHA_ENABLED` 控制）。

- [ ] **Step 2: 端到端冒烟（真 Redis + 真 DB + FakeSmsSender）**

```bash
bun run api &
sleep 2
curl -s -XPOST localhost:8080/auth/sms/send -H 'content-type: application/json' -d '{"phone":"+8613900000000"}'
# 控制台 [FakeSMS] 打印验证码，记下 CODE
# curl -s -XPOST localhost:8080/auth/sms/verify -H 'content-type: application/json' -d '{"phone":"+8613900000000","code":"<CODE>"}'
kill %1
```
Expected: send 返回 `{"ok":true}` 且控制台打印验证码；用该码 verify 返回 `{token, user}`。
> 冒烟产生的测试用户可手动清理：`bun --env-file=../../.env.bidsaas.local -e "import('./src/repos/users').then(async m=>{const u=await m.findUserByIdentity('phone','+8613900000000'); if(u){const {getDb}=await import('./src/db/client');const {users}=await import('./src/db/schema');const {eq}=await import('drizzle-orm'); await getDb().delete(users).where(eq(users.id,u.id))}})"`

- [ ] **Step 3: 全量测试 + 类型检查**

Run: `cd apps/api && bun --env-file=../../.env.bidsaas.local test && bun run typecheck`
Expected: 全绿（health/env 无需 env，repos/redis/auth 需 env）。

- [ ] **Step 4: 提交并合并**

```bash
git add apps/api/src/index.ts
git commit -m "feat(spec004): 入口装配 redis/sms/auth + 端到端冒烟

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git checkout main
git merge --no-ff phase0/spec004-phone-auth -m "merge spec004: 手机号验证码鉴权"
git push origin main
```

---

## 验收清单（spec004 完成判据）

- [ ] `POST /auth/sms/send` 发码（FakeSmsSender 打印 / 有凭据则真发）。
- [ ] `POST /auth/sms/verify` 正确码 → 返回不透明 `token` + `user`，错误码 401；验证码一次性。
- [ ] `GET /auth/me`（Bearer）返回当前用户，无/错令牌 401；`POST /auth/logout` 后该令牌失效。
- [ ] 首登自动建用户（`createUserWithIdentity` phone 身份）；复登复用同一用户。
- [ ] DB 只存令牌 sha256 哈希；会话可撤销。
- [ ] **防刷默认姿态正确**：`CAPTCHA_ENABLED` 默认 true（开发期 DevPass 放行、生产无凭据 fail-closed 抛错）；限频四层默认关，单测覆盖"默认关→放行""逐层开→拦截"。
- [ ] 阿里云短信凭据缺失时自动降级 FakeSmsSender；齐全时走真发。
- [ ] `bun test`（含 6 项 sms-code 防刷用例）+ `typecheck` 全绿。
- [ ] 真实阿里云滑块校验器 + 前端滑块 = **spec004.1**（本 spec 不含）。
