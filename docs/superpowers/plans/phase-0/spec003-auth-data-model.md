# spec003 · 鉴权数据模型 + Drizzle 迁移 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 定义 C 端鉴权的「账号 + 可插拔身份」数据模型——`users`(账号本体)、`user_identities`(登录身份，为微信/支付宝等第三方登录预留)、`sessions`(会话)，用 drizzle-kit 迁移到 PG16 `bidsaas`，并提供可测的仓储函数，供 spec004 鉴权流程调用。

**Architecture:** `users` 只存账号本体；登录方式拆到 `user_identities`（`UNIQUE(provider, identifier)`），Phase 0 仅实现 `phone` provider，后续加微信只是新增身份行 + 一条登录路由，零 schema 改动。Schema 一表一文件，注入 `drizzle(client, { schema })`；仓储封装查询便于单测。**管理端用户是另一套 `admin_users`，本 spec 不涉及（Phase 3）。**

**Tech Stack:** Drizzle ORM（pg-core）、drizzle-kit 迁移、`bun:test`（集成测试连真库 bidsaas）。

## Global Constraints

见 `spec000-index.md`。本 spec 关键约束：
- 表落 `bidsaas` 库 `public`；UUID 主键用 `gen_random_uuid()`（PG16 内置）。
- 仓储测试为**集成测试**，连真库 `bidsaas`，须 `--env-file=../../.env.bidsaas.local` 运行并自清理。
- 时间戳一律 `timestamptz`。
- 账号身份可插拔（架构 §5.2）：C 端 `users`+`user_identities`；后台 `admin_users` 与之**完全分离**。
- 在 `main` 上先开分支再改；提交信息结尾附 Co-Authored-By。

---

## File Structure

```
apps/api/
├── src/
│   ├── db/
│   │   ├── client.ts                  # 改：drizzle(client, { schema })
│   │   └── schema/
│   │       ├── index.ts               # 新：汇出 users / user_identities / sessions
│   │       ├── users.ts               # 新：users + user_status 枚举
│   │       ├── user-identities.ts     # 新：user_identities + identity_provider 枚举
│   │       └── sessions.ts            # 新：sessions
│   └── repos/
│       ├── users.ts                   # 新：getUserById/findUserByIdentity/createUserWithIdentity/addIdentity
│       └── sessions.ts                # 新：createSession/findValidSession/revokeSession
├── drizzle/                           # 新：迁移 SQL（入库）
└── test/repos/
    ├── users.test.ts                  # 新：集成测试
    └── sessions.test.ts               # 新：集成测试
```

---

## Interfaces（本 spec 对外产出，供 spec004 依赖）

- Produces:
  - 类型：
    - `User = typeof users.$inferSelect` → `{ id, status, nickname, avatarUrl, createdAt, updatedAt }`
    - `UserIdentity = typeof userIdentities.$inferSelect`
    - `Session = typeof sessions.$inferSelect`
    - `IdentityProvider = "phone" | "wechat" | "alipay"`
  - `db`：类型化 Drizzle 实例。
  - 用户/身份仓储 `repos/users.ts`：
    - `getUserById(id: string): Promise<User | null>`
    - `findUserByIdentity(provider: IdentityProvider, identifier: string): Promise<User | null>`
    - `createUserWithIdentity(input: { provider: IdentityProvider; identifier: string; verifiedAt?: Date; nickname?: string; termsAgreedAt?: Date }): Promise<User>`（事务内建 user + identity）
    - `addIdentity(userId: string, provider: IdentityProvider, identifier: string, verifiedAt?: Date): Promise<void>`（账号绑定）
  - 会话仓储 `repos/sessions.ts`：
    - `createSession(input: { userId: string; tokenHash: string; expiresAt: Date; userAgent?: string; ip?: string }): Promise<Session>`
    - `findValidSession(tokenHash: string, now?: Date): Promise<Session | null>`
    - `revokeSession(id: string): Promise<void>`

> spec004 手机号登录用法：短信验证通过 → `findUserByIdentity("phone", phone)`，为空则 `createUserWithIdentity({ provider:"phone", identifier:phone, verifiedAt:new Date() })` → 再 `createSession(...)`。

---

## Task 1: Drizzle schema（users / user_identities / sessions）+ 注入 client

**Files:**
- Create: `apps/api/src/db/schema/users.ts`、`user-identities.ts`、`sessions.ts`、`index.ts`
- Modify: `apps/api/src/db/client.ts`

- [ ] **Step 1: 开分支**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout -b phase0/spec003-auth-model
```

- [ ] **Step 2: 写 `apps/api/src/db/schema/users.ts`**

```ts
import { pgTable, uuid, text, timestamp, pgEnum } from "drizzle-orm/pg-core"

export const userStatus = pgEnum("user_status", ["active", "banned"])

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: userStatus("status").notNull().default("active"),
  nickname: text("nickname"),
  avatarUrl: text("avatar_url"),
  termsAgreedAt: timestamp("terms_agreed_at", { withTimezone: true }), // 注册即同意协议的时间（合规留痕）
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
```

- [ ] **Step 3: 写 `apps/api/src/db/schema/user-identities.ts`**

```ts
import { pgTable, uuid, text, timestamp, pgEnum, unique, index } from "drizzle-orm/pg-core"
import { users } from "./users"

export const identityProvider = pgEnum("identity_provider", ["phone", "wechat", "alipay"])
export type IdentityProvider = (typeof identityProvider.enumValues)[number]

export const userIdentities = pgTable(
  "user_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: identityProvider("provider").notNull(),
    identifier: text("identifier").notNull(),
    credential: text("credential"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: unique("user_identities_provider_identifier_uq").on(t.provider, t.identifier),
    byUser: index("user_identities_user_id_idx").on(t.userId),
  }),
)

export type UserIdentity = typeof userIdentities.$inferSelect
export type NewUserIdentity = typeof userIdentities.$inferInsert
```

- [ ] **Step 4: 写 `apps/api/src/db/schema/sessions.ts`**

```ts
import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core"
import { users } from "./users"

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    userAgent: text("user_agent"),
    ip: text("ip"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byUser: index("sessions_user_id_idx").on(t.userId),
    byTokenHash: index("sessions_token_hash_idx").on(t.tokenHash),
  }),
)

export type Session = typeof sessions.$inferSelect
export type NewSession = typeof sessions.$inferInsert
```

- [ ] **Step 5: 写 `apps/api/src/db/schema/index.ts`**

```ts
export * from "./users"
export * from "./user-identities"
export * from "./sessions"
```

- [ ] **Step 6: 改 `apps/api/src/db/client.ts` 注入 schema**

```ts
import { drizzle } from "drizzle-orm/postgres-js"
import { sql } from "drizzle-orm"
import postgres from "postgres"
import { env } from "../config/env"
import * as schema from "./schema"

const client = postgres(env.DATABASE_URL, { max: 10 })
export const db = drizzle(client, { schema })

export async function pingDb(): Promise<boolean> {
  try {
    await db.execute(sql`select 1`)
    return true
  } catch {
    return false
  }
}
```

- [ ] **Step 7: 类型检查**

Run: `cd apps/api && bun run typecheck`
Expected: 通过。

- [ ] **Step 8: 提交**

```bash
git add apps/api/src/db
git commit -m "feat(spec003): users/user_identities/sessions schema + 注入 client

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 生成并应用迁移到 bidsaas

**Files:**
- Create: `apps/api/drizzle/*`

- [ ] **Step 1: 生成迁移 SQL**

Run: `cd apps/api && bun run db:generate`
Expected: 生成 `apps/api/drizzle/0000_*.sql`。

- [ ] **Step 2: 人工确认 SQL**

Run: `cat apps/api/drizzle/0000_*.sql`
Expected: 含 `CREATE TYPE user_status`、`CREATE TYPE identity_provider`、三张表、`user_identities` 的 `UNIQUE(provider, identifier)`、外键 `ON DELETE CASCADE`、索引。

- [ ] **Step 3: 应用迁移到 bidsaas**

Run: `cd apps/api && bun run db:migrate`
Expected: 成功，建 `__drizzle_migrations` 元数据表。

- [ ] **Step 4: 验证三张表存在**

Run:
```bash
cd apps/api && bun --env-file=../../.env.bidsaas.local -e "import('./src/db/client').then(async m => { const { sql } = await import('drizzle-orm'); const r = await m.db.execute(sql\`select table_name from information_schema.tables where table_schema='public' and table_name in ('users','user_identities','sessions') order by 1\`); console.log(r) })"
```
Expected: 输出 `sessions`、`user_identities`、`users` 三行。

- [ ] **Step 5: 提交**

```bash
git add apps/api/drizzle
git commit -m "feat(spec003): 生成并应用迁移到 bidsaas（users/user_identities/sessions）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 用户/身份仓储 + 集成测试

**Files:**
- Create: `apps/api/src/repos/users.ts`、`apps/api/test/repos/users.test.ts`

- [ ] **Step 1: 写失败测试 `apps/api/test/repos/users.test.ts`**

```ts
import { describe, it, expect, afterAll } from "bun:test"
import {
  getUserById,
  findUserByIdentity,
  createUserWithIdentity,
  addIdentity,
} from "../../src/repos/users"
import { db } from "../../src/db/client"
import { users } from "../../src/db/schema"
import { eq } from "drizzle-orm"

const phone = `+8613${Date.now().toString().slice(-9)}`
let createdId = ""

afterAll(async () => {
  if (createdId) await db.delete(users).where(eq(users.id, createdId)) // 级联删 identities
})

describe("users repo", () => {
  it("createUserWithIdentity then findUserByIdentity returns same user", async () => {
    const u = await createUserWithIdentity({ provider: "phone", identifier: phone, verifiedAt: new Date() })
    createdId = u.id
    expect(u.status).toBe("active")
    const found = await findUserByIdentity("phone", phone)
    expect(found?.id).toBe(u.id)
  })

  it("getUserById returns user; missing id -> null", async () => {
    expect((await getUserById(createdId))?.id).toBe(createdId)
    expect(await getUserById("00000000-0000-0000-0000-000000000000")).toBeNull()
  })

  it("findUserByIdentity returns null for unknown identity", async () => {
    expect(await findUserByIdentity("phone", "+860000000000")).toBeNull()
    expect(await findUserByIdentity("wechat", phone)).toBeNull()
  })

  it("addIdentity binds a second identity to the same user", async () => {
    await addIdentity(createdId, "wechat", `wx_${phone}`)
    const viaWechat = await findUserByIdentity("wechat", `wx_${phone}`)
    expect(viaWechat?.id).toBe(createdId)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/api && bun --env-file=../../.env.bidsaas.local test test/repos/users.test.ts`
Expected: FAIL（`../../src/repos/users` 不存在）。

- [ ] **Step 3: 写 `apps/api/src/repos/users.ts`**

```ts
import { and, eq } from "drizzle-orm"
import { db } from "../db/client"
import { users, userIdentities, type User, type IdentityProvider } from "../db/schema"

export async function getUserById(id: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1)
  return row ?? null
}

export async function findUserByIdentity(
  provider: IdentityProvider,
  identifier: string,
): Promise<User | null> {
  const [row] = await db
    .select({ u: users })
    .from(userIdentities)
    .innerJoin(users, eq(userIdentities.userId, users.id))
    .where(and(eq(userIdentities.provider, provider), eq(userIdentities.identifier, identifier)))
    .limit(1)
  return row?.u ?? null
}

export async function createUserWithIdentity(input: {
  provider: IdentityProvider
  identifier: string
  verifiedAt?: Date
  nickname?: string
  termsAgreedAt?: Date
}): Promise<User> {
  return db.transaction(async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({ nickname: input.nickname ?? null, termsAgreedAt: input.termsAgreedAt ?? null })
      .returning()
    await tx.insert(userIdentities).values({
      userId: u!.id,
      provider: input.provider,
      identifier: input.identifier,
      verifiedAt: input.verifiedAt ?? null,
    })
    return u!
  })
}

export async function addIdentity(
  userId: string,
  provider: IdentityProvider,
  identifier: string,
  verifiedAt?: Date,
): Promise<void> {
  await db.insert(userIdentities).values({ userId, provider, identifier, verifiedAt: verifiedAt ?? null })
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/api && bun --env-file=../../.env.bidsaas.local test test/repos/users.test.ts`
Expected: PASS（4 项），结束后自清理。

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/repos/users.ts apps/api/test/repos/users.test.ts
git commit -m "feat(spec003): 用户/身份仓储（identity 可插拔）+ 集成测试

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 会话仓储 + 集成测试 + 合并

**Files:**
- Create: `apps/api/src/repos/sessions.ts`、`apps/api/test/repos/sessions.test.ts`

- [ ] **Step 1: 写失败测试 `apps/api/test/repos/sessions.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { createSession, findValidSession, revokeSession } from "../../src/repos/sessions"
import { createUserWithIdentity } from "../../src/repos/users"
import { db } from "../../src/db/client"
import { users } from "../../src/db/schema"
import { eq } from "drizzle-orm"

const phone = `+8613${Date.now().toString().slice(-9)}`
let userId = ""

beforeAll(async () => {
  const u = await createUserWithIdentity({ provider: "phone", identifier: phone, verifiedAt: new Date() })
  userId = u.id
})
afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId)) // 级联删 sessions/identities
})

describe("sessions repo", () => {
  it("createSession then findValidSession returns it", async () => {
    const s = await createSession({ userId, tokenHash: "hash-a", expiresAt: new Date(Date.now() + 3600_000) })
    expect(s.userId).toBe(userId)
    expect((await findValidSession("hash-a"))?.id).toBe(s.id)
  })

  it("expired session is not valid", async () => {
    await createSession({ userId, tokenHash: "hash-expired", expiresAt: new Date(Date.now() - 1000) })
    expect(await findValidSession("hash-expired")).toBeNull()
  })

  it("revoked session is not valid", async () => {
    const s = await createSession({ userId, tokenHash: "hash-revoke", expiresAt: new Date(Date.now() + 3600_000) })
    await revokeSession(s.id)
    expect(await findValidSession("hash-revoke")).toBeNull()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/api && bun --env-file=../../.env.bidsaas.local test test/repos/sessions.test.ts`
Expected: FAIL（`../../src/repos/sessions` 不存在）。

- [ ] **Step 3: 写 `apps/api/src/repos/sessions.ts`**

```ts
import { and, eq, gt, isNull } from "drizzle-orm"
import { db } from "../db/client"
import { sessions, type Session } from "../db/schema"

export async function createSession(input: {
  userId: string
  tokenHash: string
  expiresAt: Date
  userAgent?: string
  ip?: string
}): Promise<Session> {
  const [row] = await db.insert(sessions).values(input).returning()
  return row!
}

export async function findValidSession(
  tokenHash: string,
  now: Date = new Date(),
): Promise<Session | null> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(
      and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)),
    )
    .limit(1)
  return row ?? null
}

export async function revokeSession(id: string): Promise<void> {
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, id))
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/api && bun --env-file=../../.env.bidsaas.local test test/repos/sessions.test.ts`
Expected: PASS（3 项）。

- [ ] **Step 5: 全量测试 + 类型检查**

Run: `cd apps/api && bun --env-file=../../.env.bidsaas.local test && bun run typecheck`
Expected: 全绿。

- [ ] **Step 6: 提交并合并**

```bash
git add apps/api/src/repos/sessions.ts apps/api/test/repos/sessions.test.ts
git commit -m "feat(spec003): 会话仓储 create/findValid/revoke + 集成测试

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git checkout main
git merge --no-ff phase0/spec003-auth-model -m "merge spec003: 鉴权数据模型（账号+身份+会话）"
git push origin main
```

---

## 验收清单（spec003 完成判据）

- [ ] `users`、`user_identities`、`sessions` 已迁移到 bidsaas `public`（枚举/外键级联/`UNIQUE(provider,identifier)`/索引齐全）。
- [ ] 迁移文件入库 `apps/api/drizzle/`，`db:generate`/`db:migrate` 可复跑。
- [ ] 用户/身份仓储：getUserById / findUserByIdentity / createUserWithIdentity / addIdentity，集成测试通过并自清理；同一 user 可绑多身份（phone+wechat）。
- [ ] 会话仓储：createSession / findValidSession（排除过期+撤销）/ revokeSession，集成测试通过。
- [ ] `db` 注入 schema；`bun test` + `typecheck` 全绿。
- [ ] 第三方登录（微信/支付宝）零 schema 改动可扩展；管理端 `admin_users` 不在本 spec（Phase 3）。
