# spec003 · 鉴权数据模型 + Drizzle 迁移 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 定义鉴权所需的 `users`、`sessions` 两张表（Drizzle schema），用 drizzle-kit 生成并应用迁移到 PG16 `bidsaas`，并提供可测的用户/会话仓储函数，供 spec004 鉴权流程直接调用。

**Architecture:** Schema 按"一表一文件"放 `src/db/schema/`，经 `schema/index.ts` 汇出并注入 `drizzle(client, { schema })` 获得类型化 `db`。仓储函数（`repos/`）封装查询，便于单测与复用。迁移文件入库，应用到 bidsaas 的 `public` schema。

**Tech Stack:** Drizzle ORM（pg-core）、drizzle-kit 迁移、`bun:test`（集成测试连真库 bidsaas）。

## Global Constraints

见 `spec000-index.md`。本 spec 关键约束：
- 表落 `bidsaas` 库 `public` schema；UUID 主键用 `gen_random_uuid()`（PG16 内置）。
- 仓储测试为**集成测试**，连真库 `bidsaas`，须 `--env-file=../../.env.bidsaas.local` 运行，并自清理测试数据。
- 时间戳一律 `timestamptz`。
- 在 `main` 上先开分支再改；提交信息结尾附 Co-Authored-By。

---

## File Structure

```
apps/api/
├── src/
│   ├── db/
│   │   ├── client.ts            # 改：drizzle(client, { schema }) 注入 schema
│   │   └── schema/
│   │       ├── index.ts         # 新：汇出 users、sessions
│   │       ├── users.ts         # 新：users 表 + user_status 枚举
│   │       └── sessions.ts      # 新：sessions 表
│   └── repos/
│       ├── users.ts             # 新：createUser/findByPhone/getById
│       └── sessions.ts          # 新：create/findValid/revoke
├── drizzle/                     # 新：drizzle-kit 生成的迁移 SQL（入库）
└── test/
    └── repos/
        ├── users.test.ts        # 新：集成测试
        └── sessions.test.ts     # 新：集成测试
```

---

## Interfaces（本 spec 对外产出，供 spec004 依赖）

- Produces:
  - 表与类型：
    - `users`：`{ id: uuid, phone: text unique, status: 'active'|'banned', createdAt, updatedAt }`，类型 `User = typeof users.$inferSelect`。
    - `sessions`：`{ id, userId, tokenHash, userAgent?, ip?, expiresAt, revokedAt?, createdAt }`，类型 `Session = typeof sessions.$inferSelect`。
  - `db`：类型化 Drizzle 实例（带 schema）。
  - 用户仓储 `repos/users.ts`：
    - `createUser(phone: string): Promise<User>`
    - `findUserByPhone(phone: string): Promise<User | null>`
    - `getUserById(id: string): Promise<User | null>`
  - 会话仓储 `repos/sessions.ts`：
    - `createSession(input: { userId: string; tokenHash: string; expiresAt: Date; userAgent?: string; ip?: string }): Promise<Session>`
    - `findValidSession(tokenHash: string, now?: Date): Promise<Session | null>`（未撤销且未过期）
    - `revokeSession(id: string): Promise<void>`

---

## Task 1: Drizzle schema（users、sessions）+ 注入 client

**Files:**
- Create: `apps/api/src/db/schema/users.ts`、`sessions.ts`、`index.ts`
- Modify: `apps/api/src/db/client.ts`

**Interfaces:**
- Consumes: spec002 的 `db`/`client`。
- Produces: `users`、`sessions` 表定义；类型化 `db`。

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
  phone: text("phone").notNull().unique(),
  status: userStatus("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
```

- [ ] **Step 3: 写 `apps/api/src/db/schema/sessions.ts`**

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

- [ ] **Step 4: 写 `apps/api/src/db/schema/index.ts`**

```ts
export * from "./users"
export * from "./sessions"
```

- [ ] **Step 5: 改 `apps/api/src/db/client.ts` 注入 schema**

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

- [ ] **Step 6: 类型检查**

Run: `cd apps/api && bun run typecheck`
Expected: 通过（schema 类型正确）。

- [ ] **Step 7: 提交**

```bash
git add apps/api/src/db
git commit -m "feat(spec003): users/sessions Drizzle schema + 注入 client

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 生成并应用迁移到 bidsaas

**Files:**
- Create: `apps/api/drizzle/*`（drizzle-kit 生成）

**Interfaces:**
- Produces: bidsaas 中存在 `users`、`sessions` 表。

- [ ] **Step 1: 生成迁移 SQL**

Run: `cd apps/api && bun run db:generate`
Expected: `apps/api/drizzle/` 下生成 `0000_*.sql`（含 `CREATE TYPE user_status`、`CREATE TABLE users`、`CREATE TABLE sessions` + 索引）。

- [ ] **Step 2: 检查生成的 SQL（人工确认）**

Run: `cat apps/api/drizzle/0000_*.sql`
Expected: 含 `gen_random_uuid()`、`user_status` 枚举、外键 `sessions.user_id -> users.id ON DELETE CASCADE`、两个索引。

- [ ] **Step 3: 应用迁移到 bidsaas**

Run: `cd apps/api && bun run db:migrate`
Expected: 迁移成功（无错误）；首次会建 `__drizzle_migrations` 元数据表。

- [ ] **Step 4: 验证表已存在（真库）**

Run:
```bash
cd apps/api && bun --env-file=../../.env.bidsaas.local -e "import('./src/db/client').then(async m => { const { sql } = await import('drizzle-orm'); const r = await m.db.execute(sql\`select table_name from information_schema.tables where table_schema='public' and table_name in ('users','sessions') order by 1\`); console.log(r) })"
```
Expected: 输出包含 `users` 与 `sessions` 两行。

- [ ] **Step 5: 提交**

```bash
git add apps/api/drizzle
git commit -m "feat(spec003): 生成并应用 users/sessions 迁移到 bidsaas

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 用户仓储 + 集成测试

**Files:**
- Create: `apps/api/src/repos/users.ts`、`apps/api/test/repos/users.test.ts`

**Interfaces:**
- Consumes: `db`、`users`、`User`。
- Produces: `createUser`、`findUserByPhone`、`getUserById`。

- [ ] **Step 1: 写失败测试 `apps/api/test/repos/users.test.ts`**

```ts
import { describe, it, expect, afterAll } from "bun:test"
import { createUser, findUserByPhone, getUserById } from "../../src/repos/users"
import { db } from "../../src/db/client"
import { users } from "../../src/db/schema"
import { eq } from "drizzle-orm"

const testPhone = `+8613${Date.now().toString().slice(-9)}`
let createdId: string | null = null

afterAll(async () => {
  if (createdId) await db.delete(users).where(eq(users.id, createdId))
})

describe("users repo", () => {
  it("createUser then findUserByPhone returns same row", async () => {
    const u = await createUser(testPhone)
    createdId = u.id
    expect(u.phone).toBe(testPhone)
    expect(u.status).toBe("active")
    const found = await findUserByPhone(testPhone)
    expect(found?.id).toBe(u.id)
  })

  it("getUserById returns the user; missing id returns null", async () => {
    const found = await getUserById(createdId!)
    expect(found?.phone).toBe(testPhone)
    const none = await getUserById("00000000-0000-0000-0000-000000000000")
    expect(none).toBeNull()
  })

  it("findUserByPhone returns null for unknown phone", async () => {
    expect(await findUserByPhone("+860000000000")).toBeNull()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/api && bun --env-file=../../.env.bidsaas.local test test/repos/users.test.ts`
Expected: FAIL（`../../src/repos/users` 不存在）。

- [ ] **Step 3: 写 `apps/api/src/repos/users.ts`**

```ts
import { eq } from "drizzle-orm"
import { db } from "../db/client"
import { users, type User } from "../db/schema"

export async function createUser(phone: string): Promise<User> {
  const [row] = await db.insert(users).values({ phone }).returning()
  return row!
}

export async function findUserByPhone(phone: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.phone, phone)).limit(1)
  return row ?? null
}

export async function getUserById(id: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1)
  return row ?? null
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/api && bun --env-file=../../.env.bidsaas.local test test/repos/users.test.ts`
Expected: PASS（3 项），测试结束后自清理。

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/repos/users.ts apps/api/test/repos/users.test.ts
git commit -m "feat(spec003): 用户仓储 createUser/findByPhone/getById + 集成测试

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 会话仓储 + 集成测试 + 合并

**Files:**
- Create: `apps/api/src/repos/sessions.ts`、`apps/api/test/repos/sessions.test.ts`

**Interfaces:**
- Consumes: `db`、`sessions`、`Session`、`createUser`。
- Produces: `createSession`、`findValidSession`、`revokeSession`。

- [ ] **Step 1: 写失败测试 `apps/api/test/repos/sessions.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { createSession, findValidSession, revokeSession } from "../../src/repos/sessions"
import { createUser } from "../../src/repos/users"
import { db } from "../../src/db/client"
import { users } from "../../src/db/schema"
import { eq } from "drizzle-orm"

const phone = `+8613${Date.now().toString().slice(-9)}`
let userId = ""

beforeAll(async () => {
  const u = await createUser(phone)
  userId = u.id
})
afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId)) // 级联删 sessions
})

describe("sessions repo", () => {
  it("createSession then findValidSession returns it", async () => {
    const s = await createSession({
      userId,
      tokenHash: "hash-a",
      expiresAt: new Date(Date.now() + 3600_000),
    })
    expect(s.userId).toBe(userId)
    const found = await findValidSession("hash-a")
    expect(found?.id).toBe(s.id)
  })

  it("expired session is not valid", async () => {
    await createSession({
      userId,
      tokenHash: "hash-expired",
      expiresAt: new Date(Date.now() - 1000),
    })
    expect(await findValidSession("hash-expired")).toBeNull()
  })

  it("revoked session is not valid", async () => {
    const s = await createSession({
      userId,
      tokenHash: "hash-revoke",
      expiresAt: new Date(Date.now() + 3600_000),
    })
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
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
      ),
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
Expected: 全绿（health/env 不需 env，repos 需 env；统一带 --env-file 不影响前者）。

- [ ] **Step 6: 提交并合并**

```bash
git add apps/api/src/repos/sessions.ts apps/api/test/repos/sessions.test.ts
git commit -m "feat(spec003): 会话仓储 create/findValid/revoke + 集成测试

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git checkout main
git merge --no-ff phase0/spec003-auth-model -m "merge spec003: 鉴权数据模型 + 迁移"
git push origin main
```

---

## 验收清单（spec003 完成判据）

- [ ] `users`、`sessions` 表已迁移到 bidsaas `public`（含枚举、外键级联、索引）。
- [ ] 迁移文件入库 `apps/api/drizzle/`，`db:generate` / `db:migrate` 可复跑。
- [ ] 用户仓储：createUser / findUserByPhone / getUserById，集成测试通过并自清理。
- [ ] 会话仓储：createSession / findValidSession（排除过期+撤销）/ revokeSession，集成测试通过。
- [ ] `db` 已注入 schema（类型化）；`bun test` + `typecheck` 全绿。
