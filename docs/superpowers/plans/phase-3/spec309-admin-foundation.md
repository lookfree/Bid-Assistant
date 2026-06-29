# spec309 · 运营后台地基（admin 身份 + RBAC + 审计）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建运营后台**地基**：独立的 admin 身份体系（`admin_users` / `admin_roles` / `admin_audit_logs` + 独立 `admin_sessions`）、admin 账号密码登录（哈希 + opaque token，sha256 入库）、RBAC 中间件（`requireAdmin(...roles)` / `requirePermission(perm)`）、审计装置（`writeAudit(...)`），并把 admin-api 路由组挂载到 App API、`apps/admin` 子域前端接入骨架。**关键边界：admin 与 C 端 `users`/`sessions` 完全分离**——独立身份表、独立会话、独立子域（`admin.`），**不复用** Phase 0 手机验证码登录。本 spec 只做地基（身份/鉴权/审计/接入骨架），具体功能页（6 页接真实接口）在 spec310。

**Architecture:**
- 表全部落 `bidsaas` 库 `public` schema（与 C 端同库不同表）：`admin_users`（账号本体 + 密码哈希 + role + status）、`admin_roles`（角色枚举 → 权限集 JSONB）、`admin_audit_logs`（操作人/动作/对象/before/after JSONB）、`admin_sessions`（独立会话，与 C 端 `sessions` 分离）。
- **登录态与 C 端完全隔离**：admin 登录用账号 + 密码（`Bun.password` 哈希，scrypt/argon2，**不碰 native `bcrypt`**，对齐架构 §2.2 工程纪律③），签发不透明随机 token，DB 只存 `sha256` 哈希（`admin_sessions.tokenHash`）。鉴权中间件查 `admin_sessions`，**绝不查 C 端 `sessions`**；C 端 token 拿到 admin-api 解析必然落空（不同表、不同 hash 空间）→ 401。
- **RBAC 两段**：`requireAdmin(...roles)` 先解析 admin session → 注入 `c.var.admin` → 校验角色白名单；`requirePermission(perm)` 在已认证基础上按「角色→权限集」映射校验细粒度权限。角色：`superadmin`（全权）/ `finance`（订单/退款/对账）/ `ops`（用户/套餐）/ `support`（只读 + 客服）。
- **审计装置**：`writeAudit({ operator, action, target, before, after })` 写 `admin_audit_logs`，before/after 用 JSONB 留前后值，供 spec310 所有敏感操作（改套餐/调积分/退款/封禁/发奖励）调用。
- **路由组**：admin-api 全部挂在 `/admin-api/*`（与 C 端业务路由分组隔离，对齐架构 §3.1 App API 的 Admin 模块）；生产经反代按子域 `admin.<域名>` 路由到 `apps/admin` 前端容器（对齐 Phase 0 spec001 monorepo / spec007 容器部署的双子域）。
- **`apps/admin`** 前端接入骨架：独立 Next.js 应用（端口 3001），含 admin token-store（localStorage key 与 C 端隔离）+ admin api-client（`/admin-api` base）+ 登录页 + RequireAdmin 守卫；功能页留到 spec310。

**Tech Stack:** Hono 4.12、Drizzle ORM、PostgreSQL（public schema）、Zod、`Bun.password`（密码哈希）、`node:crypto`（token/sha256）、Next.js（apps/admin）、`bun:test`（集成测试连真库 bidsaas）。

## Global Constraints

见 `spec300-index.md`（Phase 3 全局约束）与 Phase 0 各 index。本 spec 关键：
- **admin 与 C 端完全分离**（架构 §3.3）：独立 `admin_users` / `admin_sessions` / 独立子域 `admin.`；**不复用** `users`/`user_identities`/`sessions`，不复用手机验证码登录。
- 表落 `bidsaas` 库 `public`；UUID 主键 `gen_random_uuid()`；时间戳一律 `timestamptz`。
- 密码哈希用 **`Bun.password`**（不碰 native `bcrypt`，§2.2 纪律③）；token = 不透明随机串，DB 只存 `sha256` 哈希；登录态可撤销（`admin_sessions`）。
- 鉴权/权限不通过返回 **401（未认证）/ 403（越权）**，语义区分。
- 敏感操作**一律留审计**（`admin_audit_logs`，操作人/时间/前后值）——本 spec 交付 `writeAudit` 装置，spec310 调用。
- 仓储/路由测试为**集成测试**，连真库 `bidsaas`，须 `--env-file=../../.env.bidsaas.local` 运行并自清理。
- TDD（先写失败测试）；`bun test` + `typecheck` 全绿；`main` 上先开分支再改；提交信息结尾附 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 分支：`phase3/spec309-admin-foundation`。

---

## File Structure

```
apps/api/
├── src/
│   ├── db/schema/
│   │   ├── admin.ts                  # 新：admin_users / admin_roles / admin_sessions / admin_audit_logs + 枚举
│   │   └── index.ts                  # 改：汇出 admin schema
│   ├── repos/
│   │   ├── admin-users.ts            # 新：findAdminByUsername/getAdminById/createAdmin/setAdminStatus
│   │   └── admin-sessions.ts         # 新：createAdminSession/findValidAdminSession/revokeAdminSession
│   ├── services/
│   │   ├── admin-auth.ts             # 新：hashAdminToken/loginAdmin/resolveAdminFromToken/logoutAdmin（Bun.password 校验）
│   │   ├── rbac.ts                   # 新：ROLE_PERMISSIONS 映射 + hasPermission
│   │   └── audit.ts                  # 新：writeAudit({operator,action,target,before,after})
│   ├── middleware/
│   │   └── admin-auth.ts             # 新：requireAdmin(...roles) / requirePermission(perm)（注入 c.var.admin）
│   ├── routes/
│   │   └── admin/
│   │       └── index.ts              # 新：admin-api 路由组（login/logout/me + 挂载点）
│   ├── config/
│   │   └── admin-seed.ts             # 新：种子 admin 角色 + 首个 superadmin（开发占位口令，env 可覆盖）
│   └── app.ts                        # 改：app.route("/admin-api", adminRoutes(...))
└── test/
    ├── repos/admin-users.test.ts     # 新：集成测试
    ├── repos/admin-sessions.test.ts  # 新：集成测试
    ├── services/rbac.test.ts         # 新：单测（纯映射）
    └── routes/admin-auth.test.ts     # 新：登录/me/越权/隔离 端到端
apps/admin/                           # 新：运营后台前端骨架（Next.js，端口 3001）
├── lib/
│   ├── admin-token-store.ts          # 新：createAdminTokenStore（localStorage key 与 C 端隔离）
│   └── admin-api.ts                  # 新：createAdminApi（/admin-api base，Bearer）
├── components/RequireAdmin.tsx       # 新：未登录跳 /login
├── app/login/page.tsx               # 新：账号密码登录页
└── test/admin-token-store.test.ts    # 新：单测
```

---

## Interfaces（本 spec 对外产出，供 spec310 依赖）

- Produces（App API 侧）：
  - 表对象：`adminUsers`、`adminRoles`、`adminSessions`、`adminAuditLogs`；类型 `AdminUser = typeof adminUsers.$inferSelect`、`AdminRole = "superadmin" | "ops" | "finance" | "support"`。
  - 仓储 `repos/admin-users.ts`：`findAdminByUsername(username) -> AdminUser | null`、`getAdminById(id)`、`createAdmin({username, passwordHash, role}) -> AdminUser`、`setAdminStatus(id, status)`。
  - 仓储 `repos/admin-sessions.ts`：`createAdminSession({adminId, tokenHash, expiresAt})`、`findValidAdminSession(tokenHash, now?)`、`revokeAdminSession(id)`。
  - 服务 `services/admin-auth.ts`：`loginAdmin(username, password) -> { token, admin } | null`、`resolveAdminFromToken(token) -> AdminUser | null`、`logoutAdmin(token)`。
  - 服务 `services/rbac.ts`：`ROLE_PERMISSIONS: Record<AdminRole, Permission[]>`、`hasPermission(role, perm) -> boolean`；`Permission` 枚举（`user.read`/`user.write`/`order.read`/`refund.write`/`plan.write`/`credit.adjust`/`config.write`/`audit.read` 等）。
  - 服务 `services/audit.ts`：`writeAudit(input: { operator: string; action: string; target?: string; before?: unknown; after?: unknown }) -> Promise<void>`。
  - 中间件 `middleware/admin-auth.ts`：`requireAdmin(...roles: AdminRole[])`（roles 为空＝任意已认证 admin）、`requirePermission(perm: Permission)`；二者把 `AdminUser` 注入 `c.var.admin`。
  - 路由：`POST /admin-api/login`（`{username, password}` → `{token, admin}` / 401）、`POST /admin-api/logout`（需鉴权 → 204）、`GET /admin-api/me`（需鉴权 → `{admin}`）。
- Produces（前端侧）：`apps/admin` 可登录骨架（token-store + api-client + 登录页 + RequireAdmin）。
- spec310 用法：每个功能路由用 `requirePermission("xxx.write")` 守卫，敏感写操作末尾调 `writeAudit({ operator: c.var.admin.username, action, target, before, after })`。

---

## Task 1: admin schema（admin_users / admin_roles / admin_sessions / admin_audit_logs）+ 迁移

**Files:** Create `apps/api/src/db/schema/admin.ts`；Modify `apps/api/src/db/schema/index.ts`、`apps/api/drizzle/*`

- [ ] **Step 1: 开分支**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout -b phase3/spec309-admin-foundation
```

- [ ] **Step 2: 写 `apps/api/src/db/schema/admin.ts`**

```ts
import { pgTable, uuid, text, jsonb, timestamp, pgEnum, index } from "drizzle-orm/pg-core"

// admin 角色（与 C 端无关，独立枚举）
export const adminRole = pgEnum("admin_role", ["superadmin", "ops", "finance", "support"])
export type AdminRole = (typeof adminRole.enumValues)[number]

export const adminStatus = pgEnum("admin_status", ["active", "disabled"])

// 运营人员账号本体（与 C 端 users 完全分离）
export const adminUsers = pgTable("admin_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),     // Bun.password 哈希（非 native bcrypt）
  role: adminRole("role").notNull().default("support"),
  status: adminStatus("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

// 角色 → 权限集（配置化；代码内有默认映射 rbac.ts，此表作可视化/覆盖载体，spec310 用）
export const adminRoles = pgTable("admin_roles", {
  role: adminRole("role").primaryKey(),
  permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

// admin 独立会话（与 C 端 sessions 分离；只存 token 的 sha256）
export const adminSessions = pgTable(
  "admin_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adminId: uuid("admin_id").notNull().references(() => adminUsers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byAdmin: index("admin_sessions_admin_id_idx").on(t.adminId),
    byTokenHash: index("admin_sessions_token_hash_idx").on(t.tokenHash),
  }),
)

// 敏感操作审计（前后值留痕）
export const adminAuditLogs = pgTable(
  "admin_audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operator: text("operator").notNull(),           // admin username（冗余存，便于审计追溯）
    action: text("action").notNull(),               // 如 refund.approve / credit.adjust / user.ban
    target: text("target"),                          // 操作对象标识（order_id / user_id ...）
    before: jsonb("before"),                         // 操作前快照
    after: jsonb("after"),                           // 操作后快照
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOperator: index("admin_audit_logs_operator_idx").on(t.operator),
    byAction: index("admin_audit_logs_action_idx").on(t.action),
  }),
)

export type AdminUser = typeof adminUsers.$inferSelect
export type NewAdminUser = typeof adminUsers.$inferInsert
export type AdminSession = typeof adminSessions.$inferSelect
export type AdminAuditLog = typeof adminAuditLogs.$inferSelect
```

- [ ] **Step 3: 汇出 `apps/api/src/db/schema/index.ts`**

在现有汇出末尾追加：

```ts
export * from "./admin"
```

- [ ] **Step 4: 生成并应用迁移**

```bash
cd apps/api && bun run db:generate
cat apps/api/drizzle/*admin*.sql 2>/dev/null || ls apps/api/drizzle
```
人工确认：含 `CREATE TYPE admin_role`、`admin_status`、四张表、`admin_users.username` 唯一、`admin_sessions.admin_id` 外键 `ON DELETE CASCADE`、索引。

```bash
cd apps/api && bun run db:migrate
```
验证四表存在：

```bash
cd apps/api && bun --env-file=../../.env.bidsaas.local -e "import('./src/db/client').then(async m => { const { sql } = await import('drizzle-orm'); const r = await m.db.execute(sql\`select table_name from information_schema.tables where table_schema='public' and table_name in ('admin_users','admin_roles','admin_sessions','admin_audit_logs') order by 1\`); console.log(r) })"
```
Expected: 四行。

- [ ] **Step 5: 类型检查 + 提交**

```bash
cd apps/api && bun run typecheck
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git add apps/api/src/db/schema/admin.ts apps/api/src/db/schema/index.ts apps/api/drizzle
git commit -m "feat(spec309): admin_users/admin_roles/admin_sessions/admin_audit_logs schema + 迁移

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: admin 仓储（admin-users / admin-sessions）+ 集成测试

**Files:** Create `apps/api/src/repos/admin-users.ts`、`apps/api/src/repos/admin-sessions.ts`、`apps/api/test/repos/admin-users.test.ts`、`apps/api/test/repos/admin-sessions.test.ts`

- [ ] **Step 1: 写失败测试 `apps/api/test/repos/admin-users.test.ts`**

```ts
import { describe, it, expect, afterAll } from "bun:test"
import {
  createAdmin,
  findAdminByUsername,
  getAdminById,
  setAdminStatus,
} from "../../src/repos/admin-users"
import { db } from "../../src/db/client"
import { adminUsers } from "../../src/db/schema"
import { eq } from "drizzle-orm"

const username = `ops_${Date.now()}`
let createdId = ""

afterAll(async () => {
  if (createdId) await db.delete(adminUsers).where(eq(adminUsers.id, createdId))
})

describe("admin-users repo", () => {
  it("createAdmin then findAdminByUsername returns same admin", async () => {
    const a = await createAdmin({ username, passwordHash: "hash-x", role: "ops" })
    createdId = a.id
    expect(a.role).toBe("ops")
    expect(a.status).toBe("active")
    expect((await findAdminByUsername(username))?.id).toBe(a.id)
  })

  it("getAdminById / unknown username -> null", async () => {
    expect((await getAdminById(createdId))?.id).toBe(createdId)
    expect(await findAdminByUsername("no_such_admin")).toBeNull()
    expect(await getAdminById("00000000-0000-0000-0000-000000000000")).toBeNull()
  })

  it("setAdminStatus disables admin", async () => {
    await setAdminStatus(createdId, "disabled")
    expect((await getAdminById(createdId))?.status).toBe("disabled")
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
cd apps/api && bun --env-file=../../.env.bidsaas.local test test/repos/admin-users.test.ts
```
Expected: FAIL（仓储不存在）。

- [ ] **Step 3: 写 `apps/api/src/repos/admin-users.ts`**

```ts
import { eq } from "drizzle-orm"
import { db } from "../db/client"
import { adminUsers, type AdminUser, type AdminRole } from "../db/schema"

export async function getAdminById(id: string): Promise<AdminUser | null> {
  const [row] = await db.select().from(adminUsers).where(eq(adminUsers.id, id)).limit(1)
  return row ?? null
}

export async function findAdminByUsername(username: string): Promise<AdminUser | null> {
  const [row] = await db.select().from(adminUsers).where(eq(adminUsers.username, username)).limit(1)
  return row ?? null
}

export async function createAdmin(input: {
  username: string
  passwordHash: string
  role: AdminRole
}): Promise<AdminUser> {
  const [row] = await db.insert(adminUsers).values(input).returning()
  return row!
}

export async function setAdminStatus(id: string, status: "active" | "disabled"): Promise<void> {
  await db.update(adminUsers).set({ status }).where(eq(adminUsers.id, id))
}
```

- [ ] **Step 4: 写失败测试 `apps/api/test/repos/admin-sessions.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import {
  createAdminSession,
  findValidAdminSession,
  revokeAdminSession,
} from "../../src/repos/admin-sessions"
import { createAdmin } from "../../src/repos/admin-users"
import { db } from "../../src/db/client"
import { adminUsers } from "../../src/db/schema"
import { eq } from "drizzle-orm"

let adminId = ""

beforeAll(async () => {
  const a = await createAdmin({ username: `sess_${Date.now()}`, passwordHash: "h", role: "support" })
  adminId = a.id
})
afterAll(async () => {
  await db.delete(adminUsers).where(eq(adminUsers.id, adminId)) // 级联删 admin_sessions
})

describe("admin-sessions repo", () => {
  it("create then findValid returns it", async () => {
    const s = await createAdminSession({ adminId, tokenHash: "ah-a", expiresAt: new Date(Date.now() + 3600_000) })
    expect(s.adminId).toBe(adminId)
    expect((await findValidAdminSession("ah-a"))?.id).toBe(s.id)
  })

  it("expired admin session is not valid", async () => {
    await createAdminSession({ adminId, tokenHash: "ah-expired", expiresAt: new Date(Date.now() - 1000) })
    expect(await findValidAdminSession("ah-expired")).toBeNull()
  })

  it("revoked admin session is not valid", async () => {
    const s = await createAdminSession({ adminId, tokenHash: "ah-revoke", expiresAt: new Date(Date.now() + 3600_000) })
    await revokeAdminSession(s.id)
    expect(await findValidAdminSession("ah-revoke")).toBeNull()
  })
})
```

- [ ] **Step 5: 写 `apps/api/src/repos/admin-sessions.ts`**

```ts
import { and, eq, gt, isNull } from "drizzle-orm"
import { db } from "../db/client"
import { adminSessions, type AdminSession } from "../db/schema"

export async function createAdminSession(input: {
  adminId: string
  tokenHash: string
  expiresAt: Date
}): Promise<AdminSession> {
  const [row] = await db.insert(adminSessions).values(input).returning()
  return row!
}

export async function findValidAdminSession(
  tokenHash: string,
  now: Date = new Date(),
): Promise<AdminSession | null> {
  const [row] = await db
    .select()
    .from(adminSessions)
    .where(
      and(eq(adminSessions.tokenHash, tokenHash), isNull(adminSessions.revokedAt), gt(adminSessions.expiresAt, now)),
    )
    .limit(1)
  return row ?? null
}

export async function revokeAdminSession(id: string): Promise<void> {
  await db.update(adminSessions).set({ revokedAt: new Date() }).where(eq(adminSessions.id, id))
}
```

- [ ] **Step 6: 运行确认通过 + 提交**

```bash
cd apps/api && bun --env-file=../../.env.bidsaas.local test test/repos/admin-users.test.ts test/repos/admin-sessions.test.ts
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git add apps/api/src/repos/admin-users.ts apps/api/src/repos/admin-sessions.ts apps/api/test/repos/admin-users.test.ts apps/api/test/repos/admin-sessions.test.ts
git commit -m "feat(spec309): admin 用户/会话仓储（独立于 C 端）+ 集成测试

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: RBAC 角色→权限映射 + 单测

**Files:** Create `apps/api/src/services/rbac.ts`、`apps/api/test/services/rbac.test.ts`

- [ ] **Step 1: 写失败测试 `apps/api/test/services/rbac.test.ts`**（纯映射，无需真库）

```ts
import { describe, it, expect } from "bun:test"
import { ROLE_PERMISSIONS, hasPermission } from "../../src/services/rbac"

describe("rbac", () => {
  it("superadmin 拥有全部权限", () => {
    expect(hasPermission("superadmin", "refund.write")).toBe(true)
    expect(hasPermission("superadmin", "config.write")).toBe(true)
    expect(hasPermission("superadmin", "credit.adjust")).toBe(true)
  })

  it("finance 管订单/退款，不能改套餐/调积分口径外的配置", () => {
    expect(hasPermission("finance", "order.read")).toBe(true)
    expect(hasPermission("finance", "refund.write")).toBe(true)
    expect(hasPermission("finance", "plan.write")).toBe(false)
    expect(hasPermission("finance", "user.write")).toBe(false)
  })

  it("ops 管用户/套餐，不能退款", () => {
    expect(hasPermission("ops", "user.write")).toBe(true)
    expect(hasPermission("ops", "plan.write")).toBe(true)
    expect(hasPermission("ops", "refund.write")).toBe(false)
  })

  it("support 只读 + 客服，无任何 write", () => {
    expect(hasPermission("support", "user.read")).toBe(true)
    expect(hasPermission("support", "order.read")).toBe(true)
    expect(hasPermission("support", "user.write")).toBe(false)
    expect(hasPermission("support", "refund.write")).toBe(false)
    expect(hasPermission("support", "credit.adjust")).toBe(false)
  })

  it("每个角色都有权限集定义", () => {
    for (const role of ["superadmin", "ops", "finance", "support"] as const) {
      expect(Array.isArray(ROLE_PERMISSIONS[role])).toBe(true)
    }
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
cd apps/api && bun test test/services/rbac.test.ts
```

- [ ] **Step 3: 写 `apps/api/src/services/rbac.ts`**

```ts
import type { AdminRole } from "../db/schema"

// 细粒度权限枚举（spec310 各功能路由按需引用）
export const PERMISSIONS = [
  "user.read", "user.write",          // 用户/会员（封禁/调整）
  "order.read", "refund.write",       // 订单/退款/对账
  "ledger.read", "credit.adjust",     // 积分账本/手动调积分
  "plan.write",                        // 套餐与积分口径
  "config.write",                      // billing_configs 配置
  "referral.write",                    // 手动发邀请奖励
  "audit.read",                        // 审计查看
] as const
export type Permission = (typeof PERMISSIONS)[number]

// superadmin 全权；其余按职责裁剪（架构 §3.3 / §5.2）
export const ROLE_PERMISSIONS: Record<AdminRole, Permission[]> = {
  superadmin: [...PERMISSIONS],
  finance: ["order.read", "refund.write", "ledger.read", "audit.read"],
  ops: ["user.read", "user.write", "plan.write", "ledger.read", "audit.read"],
  support: ["user.read", "order.read", "ledger.read"], // 只读 + 客服
}

export function hasPermission(role: AdminRole, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(perm) ?? false
}
```

- [ ] **Step 4: 通过 + 提交**

```bash
cd apps/api && bun test test/services/rbac.test.ts
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git add apps/api/src/services/rbac.ts apps/api/test/services/rbac.test.ts
git commit -m "feat(spec309): RBAC 角色→权限映射（superadmin/ops/finance/support）+ 单测

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 审计装置 writeAudit + 集成测试

**Files:** Create `apps/api/src/services/audit.ts`、`apps/api/test/services/audit.test.ts`

- [ ] **Step 1: 写失败测试 `apps/api/test/services/audit.test.ts`**

```ts
import { describe, it, expect, afterAll } from "bun:test"
import { writeAudit } from "../../src/services/audit"
import { db } from "../../src/db/client"
import { adminAuditLogs } from "../../src/db/schema"
import { eq, desc } from "drizzle-orm"

const operator = `auditor_${Date.now()}`

afterAll(async () => {
  await db.delete(adminAuditLogs).where(eq(adminAuditLogs.operator, operator))
})

describe("audit", () => {
  it("writeAudit 记录操作人/动作/对象 + 前后值", async () => {
    await writeAudit({
      operator,
      action: "plan.update",
      target: "plan-123",
      before: { priceCents: 1000 },
      after: { priceCents: 2000 },
    })
    const [row] = await db
      .select()
      .from(adminAuditLogs)
      .where(eq(adminAuditLogs.operator, operator))
      .orderBy(desc(adminAuditLogs.createdAt))
      .limit(1)
    expect(row?.action).toBe("plan.update")
    expect(row?.target).toBe("plan-123")
    expect((row?.before as { priceCents: number }).priceCents).toBe(1000)
    expect((row?.after as { priceCents: number }).priceCents).toBe(2000)
  })

  it("writeAudit 允许 before/after 缺省（如纯查询/创建）", async () => {
    await writeAudit({ operator, action: "user.ban", target: "user-9" })
    const rows = await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.operator, operator))
    expect(rows.length).toBeGreaterThanOrEqual(2)
  })
})
```

- [ ] **Step 2: 运行确认失败 → 写 `apps/api/src/services/audit.ts`**

```ts
import { db } from "../db/client"
import { adminAuditLogs } from "../db/schema"

// 敏感操作审计装置：spec310 所有写操作末尾调用，留前后值（架构 §3.3）
export async function writeAudit(input: {
  operator: string                    // admin username
  action: string                      // 如 refund.approve / credit.adjust / user.ban
  target?: string
  before?: unknown
  after?: unknown
}): Promise<void> {
  await db.insert(adminAuditLogs).values({
    operator: input.operator,
    action: input.action,
    target: input.target ?? null,
    before: (input.before ?? null) as never,
    after: (input.after ?? null) as never,
  })
}
```

- [ ] **Step 3: 通过 + 提交**

```bash
cd apps/api && bun --env-file=../../.env.bidsaas.local test test/services/audit.test.ts
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git add apps/api/src/services/audit.ts apps/api/test/services/audit.test.ts
git commit -m "feat(spec309): 审计装置 writeAudit（前后值入 admin_audit_logs）+ 集成测试

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: admin 登录服务 + RBAC 中间件

**Files:** Create `apps/api/src/services/admin-auth.ts`、`apps/api/src/middleware/admin-auth.ts`

- [ ] **Step 1: 写 `apps/api/src/services/admin-auth.ts`**

```ts
import { randomBytes, createHash } from "node:crypto"
import {
  createAdminSession,
  findValidAdminSession,
  revokeAdminSession,
} from "../repos/admin-sessions"
import { findAdminByUsername, getAdminById } from "../repos/admin-users"
import type { AdminUser } from "../db/schema"

const SESSION_TTL_MS = 8 * 60 * 60 * 1000 // admin 会话 8 小时（权限大，短时效）

export function hashAdminToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

// 密码哈希（建账号时用，种子/spec310 创建 admin 复用）
export async function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain) // 默认 argon2id，非 native bcrypt（§2.2 纪律③）
}

export async function loginAdmin(
  username: string,
  password: string,
): Promise<{ token: string; admin: AdminUser } | null> {
  const admin = await findAdminByUsername(username)
  if (!admin || admin.status !== "active") return null
  const ok = await Bun.password.verify(password, admin.passwordHash)
  if (!ok) return null
  const token = randomBytes(32).toString("hex")
  await createAdminSession({
    adminId: admin.id,
    tokenHash: hashAdminToken(token),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  })
  return { token, admin }
}

// 解析 admin token —— 只查 admin_sessions，绝不查 C 端 sessions
export async function resolveAdminFromToken(token: string): Promise<AdminUser | null> {
  const session = await findValidAdminSession(hashAdminToken(token))
  if (!session) return null
  const admin = await getAdminById(session.adminId)
  if (!admin || admin.status !== "active") return null
  return admin
}

export async function logoutAdmin(token: string): Promise<void> {
  const session = await findValidAdminSession(hashAdminToken(token))
  if (session) await revokeAdminSession(session.id)
}
```

- [ ] **Step 2: 写 `apps/api/src/middleware/admin-auth.ts`**

```ts
import { createMiddleware } from "hono/factory"
import { resolveAdminFromToken } from "../services/admin-auth"
import { hasPermission, type Permission } from "../services/rbac"
import type { AdminUser, AdminRole } from "../db/schema"

type AdminVars = { Variables: { admin: AdminUser } }

function bearer(c: { req: { header: (k: string) => string | undefined } }): string {
  const h = c.req.header("Authorization") ?? ""
  return h.startsWith("Bearer ") ? h.slice(7) : ""
}

// 解析 admin session → 注入 c.var.admin → 校验角色白名单（roles 空＝任意已认证 admin）
export function requireAdmin(...roles: AdminRole[]) {
  return createMiddleware<AdminVars>(async (c, next) => {
    const token = bearer(c)
    const admin = token ? await resolveAdminFromToken(token) : null
    if (!admin) return c.json({ error: "unauthorized" }, 401)       // 未认证
    if (roles.length > 0 && !roles.includes(admin.role)) {
      return c.json({ error: "forbidden" }, 403)                    // 越权
    }
    c.set("admin", admin)
    await next()
  })
}

// 在已认证基础上按「角色→权限」校验细粒度权限
export function requirePermission(perm: Permission) {
  return createMiddleware<AdminVars>(async (c, next) => {
    const token = bearer(c)
    const admin = token ? await resolveAdminFromToken(token) : null
    if (!admin) return c.json({ error: "unauthorized" }, 401)
    if (!hasPermission(admin.role, perm)) return c.json({ error: "forbidden" }, 403)
    c.set("admin", admin)
    await next()
  })
}
```

- [ ] **Step 3: 类型检查 + 提交**

```bash
cd apps/api && bun run typecheck
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git add apps/api/src/services/admin-auth.ts apps/api/src/middleware/admin-auth.ts
git commit -m "feat(spec309): admin 登录服务(密码哈希+opaque token) + RBAC 中间件(requireAdmin/requirePermission)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: admin-api 路由组（login/logout/me）+ 挂载 + 端到端测试

**Files:** Create `apps/api/src/routes/admin/index.ts`、`apps/api/test/routes/admin-auth.test.ts`；Modify `apps/api/src/app.ts`

- [ ] **Step 1: 写 `apps/api/src/routes/admin/index.ts`**

```ts
import { Hono } from "hono"
import { z } from "zod"
import { loginAdmin, logoutAdmin } from "../../services/admin-auth"
import { requireAdmin } from "../../middleware/admin-auth"

const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) })

export function adminRoutes() {
  const r = new Hono()

  // 公开：账号密码登录 → 独立 admin session token
  r.post("/login", async (c) => {
    const body = await c.req.json().catch(() => null)
    const parsed = loginSchema.safeParse(body)
    if (!parsed.success) return c.json({ error: "bad_request" }, 400)
    const result = await loginAdmin(parsed.data.username, parsed.data.password)
    if (!result) return c.json({ error: "invalid_credentials" }, 401)
    const { token, admin } = result
    return c.json({ token, admin: { id: admin.id, username: admin.username, role: admin.role } })
  })

  // 鉴权：登出（撤销当前 admin session）
  r.post("/logout", requireAdmin(), async (c) => {
    const token = (c.req.header("Authorization") ?? "").slice(7)
    await logoutAdmin(token)
    return c.body(null, 204)
  })

  // 鉴权：当前 admin
  r.get("/me", requireAdmin(), (c) => {
    const a = c.var.admin
    return c.json({ admin: { id: a.id, username: a.username, role: a.role, status: a.status } })
  })

  // spec310 在此挂载功能子路由：r.route("/users", ...), r.route("/orders", ...) 等
  return r
}
```

- [ ] **Step 2: 挂载到 `apps/api/src/app.ts`**

在现有路由注册处加（与 C 端业务路由组并列、独立前缀）：

```ts
import { adminRoutes } from "./routes/admin"
// ...
app.route("/admin-api", adminRoutes())
```

> 说明：admin-api 与 C 端业务路由组**完全分组隔离**，不复用 C 端 `authMiddleware`；生产经反代按子域 `admin.<域名>` 路由到 `apps/admin` 前端（§3.3、对齐 spec001/007 双子域）。

- [ ] **Step 3: 写端到端测试 `apps/api/test/routes/admin-auth.test.ts`**（覆盖登录/me/越权/C 端隔离）

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { app } from "../../src/app"
import { createAdmin } from "../../src/repos/admin-users"
import { hashPassword } from "../../src/services/admin-auth"
import { db } from "../../src/db/client"
import { adminUsers } from "../../src/db/schema"
import { eq } from "drizzle-orm"

const username = `e2e_${Date.now()}`
const password = "S3cret-pass!"
let supportId = ""

beforeAll(async () => {
  const a = await createAdmin({ username, passwordHash: await hashPassword(password), role: "support" })
  supportId = a.id
})
afterAll(async () => {
  await db.delete(adminUsers).where(eq(adminUsers.id, supportId))
})

async function call(path: string, init?: RequestInit) {
  return app.request(`http://x/admin-api${path}`, init)
}

describe("admin-api 登录与隔离", () => {
  it("登录成功签发 token，错误口令 401", async () => {
    const bad = await call("/login", { method: "POST", body: JSON.stringify({ username, password: "wrong" }) })
    expect(bad.status).toBe(401)
    const res = await call("/login", { method: "POST", body: JSON.stringify({ username, password }) })
    expect(res.status).toBe(200)
    const { token } = await res.json()
    expect(typeof token).toBe("string")
  })

  it("me 需鉴权：无 token 401；带 admin token 返回 admin", async () => {
    expect((await call("/me")).status).toBe(401)
    const login = await call("/login", { method: "POST", body: JSON.stringify({ username, password }) })
    const { token } = await login.json()
    const me = await call("/me", { headers: { Authorization: `Bearer ${token}` } })
    expect(me.status).toBe(200)
    expect((await me.json()).admin.username).toBe(username)
  })

  it("requireAdmin(role) 拒绝越权角色 403", async () => {
    // 临时挂一条只许 finance 的路由验证（或用既有受限路由）；support 调用应 403
    const login = await call("/login", { method: "POST", body: JSON.stringify({ username, password }) })
    const { token } = await login.json()
    // 借 me 之外的受限点：见 Step 4 在 app 上注册的 /admin-api/__test_finance_only
    const r = await call("/__test_finance_only", { headers: { Authorization: `Bearer ${token}` } })
    expect(r.status).toBe(403)
  })

  it("C 端 token 不能访问 admin-api（隔离）", async () => {
    // 用一个明显非 admin 的随机 token（C 端 token 在 admin_sessions 查不到）
    const r = await call("/me", { headers: { Authorization: "Bearer cside-token-deadbeef" } })
    expect(r.status).toBe(401)
  })
})
```

- [ ] **Step 4: 为越权测试加临时受限探针**（在 `adminRoutes()` 内加一条 finance-only 路由，仅供测试断言 403；或在测试里用 spec310 真实受限路由替换）

```ts
// adminRoutes() 内追加（地基期用于验证 RBAC 拒绝；spec310 接真实功能页后可删）
r.get("/__test_finance_only", requireAdmin("finance"), (c) => c.json({ ok: true }))
```

- [ ] **Step 5: 运行确认通过 + 提交**

```bash
cd apps/api && bun --env-file=../../.env.bidsaas.local test test/routes/admin-auth.test.ts
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git add apps/api/src/routes/admin apps/api/src/app.ts apps/api/test/routes/admin-auth.test.ts
git commit -m "feat(spec309): admin-api 路由组(login/logout/me)+挂载 + 越权/隔离端到端测试

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: 种子（admin 角色 + 首个 superadmin）

**Files:** Create `apps/api/src/config/admin-seed.ts`、`apps/api/test/admin-seed.test.ts`

- [ ] **Step 1: 写 `apps/api/src/config/admin-seed.ts`**

```ts
import { db } from "../db/client"
import { adminRoles, adminUsers } from "../db/schema"
import { ROLE_PERMISSIONS } from "../services/rbac"
import { hashPassword } from "../services/admin-auth"

// 种子角色权限集（与代码内 ROLE_PERMISSIONS 一致；spec310 后台可在此表覆盖/可视化）
export async function seedAdminRoles(): Promise<void> {
  for (const role of ["superadmin", "ops", "finance", "support"] as const) {
    await db
      .insert(adminRoles)
      .values({ role, permissions: ROLE_PERMISSIONS[role] })
      .onConflictDoNothing({ target: adminRoles.role })
  }
}

// 首个 superadmin（账号/口令从 env 注入；缺省用开发占位，生产必须改）
export async function seedSuperadmin(env: {
  ADMIN_BOOTSTRAP_USERNAME?: string
  ADMIN_BOOTSTRAP_PASSWORD?: string
}): Promise<void> {
  const username = env.ADMIN_BOOTSTRAP_USERNAME ?? "admin"
  const password = env.ADMIN_BOOTSTRAP_PASSWORD ?? "ChangeMe-dev-only"
  await db
    .insert(adminUsers)
    .values({ username, passwordHash: await hashPassword(password), role: "superadmin" })
    .onConflictDoNothing({ target: adminUsers.username })
}
```

- [ ] **Step 2: 写测试 `apps/api/test/admin-seed.test.ts`**

```ts
import { describe, it, expect, afterAll } from "bun:test"
import { seedAdminRoles, seedSuperadmin } from "../src/config/admin-seed"
import { loginAdmin } from "../src/services/admin-auth"
import { db } from "../src/db/client"
import { adminUsers } from "../src/db/schema"
import { eq } from "drizzle-orm"

const username = `boot_${Date.now()}`
const password = "Boot-pass-123"

afterAll(async () => {
  await db.delete(adminUsers).where(eq(adminUsers.username, username))
})

describe("admin seed", () => {
  it("seedAdminRoles 幂等（重复跑不报错）", async () => {
    await seedAdminRoles()
    await seedAdminRoles()
    expect(true).toBe(true)
  })

  it("seedSuperadmin 建账号后可登录", async () => {
    await seedSuperadmin({ ADMIN_BOOTSTRAP_USERNAME: username, ADMIN_BOOTSTRAP_PASSWORD: password })
    const r = await loginAdmin(username, password)
    expect(r?.admin.role).toBe("superadmin")
  })
})
```

- [ ] **Step 3: 通过 + 提交**

```bash
cd apps/api && bun --env-file=../../.env.bidsaas.local test test/admin-seed.test.ts
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git add apps/api/src/config/admin-seed.ts apps/api/test/admin-seed.test.ts
git commit -m "feat(spec309): admin 种子（角色权限集 + 首个 superadmin，env 注入，幂等）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: apps/admin 前端接入骨架（token-store + api-client + 登录页 + RequireAdmin）

**Files:** Create `apps/admin/lib/admin-token-store.ts`、`apps/admin/lib/admin-api.ts`、`apps/admin/components/RequireAdmin.tsx`、`apps/admin/app/login/page.tsx`、`apps/admin/test/admin-token-store.test.ts`

> 前提：`apps/admin` 工程已在 Phase 0 spec001 monorepo 脚手架中建好（Next.js，端口 3001）。若尚未建，先按 spec001 同模式 `bun create` 一个 Next.js 应用并加入 workspace，再做本 Task。

- [ ] **Step 1: 写失败测试 `apps/admin/test/admin-token-store.test.ts`**

```ts
import { describe, it, expect } from "bun:test"
import { createAdminTokenStore } from "../lib/admin-token-store"

function memStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  }
}

describe("admin-token-store", () => {
  it("set/get/clear，且 key 与 C 端隔离", () => {
    const s = memStorage()
    const store = createAdminTokenStore(s)
    expect(store.get()).toBeNull()
    store.set("adm-token")
    expect(store.get()).toBe("adm-token")
    // 隔离：不得使用 C 端 key 'bid.token'
    expect(s.getItem("bid.token")).toBeNull()
    expect(s.getItem("bid.admin.token")).toBe("adm-token")
    store.clear()
    expect(store.get()).toBeNull()
  })
})
```

- [ ] **Step 2: 写 `apps/admin/lib/admin-token-store.ts`**（key 与 C 端 `bid.token` 隔离）

```ts
type SimpleStorage = {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
  removeItem(k: string): void
}

const KEY = "bid.admin.token" // 与 C 端 'bid.token' 完全隔离

export function createAdminTokenStore(storage: SimpleStorage) {
  return {
    get: (): string | null => storage.getItem(KEY),
    set: (token: string): void => storage.setItem(KEY, token),
    clear: (): void => storage.removeItem(KEY),
  }
}

function safeStorage(): SimpleStorage {
  if (typeof window !== "undefined" && window.localStorage) return window.localStorage
  const m = new Map<string, string>()
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  }
}

export const adminTokenStore = createAdminTokenStore(safeStorage())
```

- [ ] **Step 3: 写 `apps/admin/lib/admin-api.ts`**（base `/admin-api`，Bearer）

```ts
import { adminTokenStore } from "./admin-token-store"

const baseUrl = process.env.NEXT_PUBLIC_ADMIN_API_BASE_URL ?? "/admin-api"

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set("Content-Type", "application/json")
  const token = adminTokenStore.get()
  if (token) headers.set("Authorization", `Bearer ${token}`)
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers })
  if (!res.ok) throw new Error(`admin api ${res.status}`)
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

export const adminApi = {
  login: (username: string, password: string) =>
    req<{ token: string; admin: { id: string; username: string; role: string } }>("/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  me: () => req<{ admin: { id: string; username: string; role: string; status: string } }>("/me"),
  logout: () => req<void>("/logout", { method: "POST" }),
}
```

- [ ] **Step 4: 写 `apps/admin/components/RequireAdmin.tsx` + `apps/admin/app/login/page.tsx`**（登录骨架，调 `adminApi.login` → 存 token → 进后台；未登录 `RequireAdmin` 跳 `/login`）。登录页用账号 + 密码两个输入框，提交调 `adminApi.login(username, password)`，成功 `adminTokenStore.set(token)` 后跳首页。

- [ ] **Step 5: 单测通过 + 提交合并**

```bash
cd apps/admin && bun test test/admin-token-store.test.ts
# 全量回归（App API 集成测试 + 类型检查）
cd ../api && bun --env-file=../../.env.bidsaas.local test && bun run typecheck
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git add apps/admin/lib apps/admin/components apps/admin/app/login apps/admin/test
git commit -m "feat(spec309): apps/admin 前端接入骨架（独立 token-store/api-client/登录页/RequireAdmin）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git checkout main
git merge --no-ff phase3/spec309-admin-foundation -m "merge spec309: 运营后台地基（admin 身份+RBAC+审计）"
git push origin main
```

---

## 验收清单（spec309 完成判据）

- [ ] 四张 admin 表已迁移到 bidsaas `public`：`admin_users`（username 唯一 / password_hash / role 枚举 / status）、`admin_roles`（角色→权限集 JSONB）、`admin_sessions`（独立会话 / token sha256 / 外键级联）、`admin_audit_logs`（operator/action/target/before/after JSONB）。
- [ ] **与 C 端完全分离**：独立 `admin_users` / `admin_sessions`，不复用 `users`/`sessions`/手机验证码登录；admin token 只查 `admin_sessions`。
- [ ] admin 登录：账号 + 密码（`Bun.password` 哈希，非 native bcrypt）→ 签发 opaque token，DB 存 sha256；`POST /admin-api/login`、`/admin-api/logout`、`/admin-api/me` 可用。
- [ ] RBAC：`requireAdmin(...roles)` 解析 admin session 注入 `c.var.admin` 并校验角色，越权 **403**、未认证 **401**；`requirePermission(perm)` 按「角色→权限」校验（superadmin 全权 / finance 订单退款 / ops 用户套餐 / support 只读）。
- [ ] 审计：`writeAudit({operator,action,target,before,after})` 写 `admin_audit_logs` 留前后值，供 spec310 调用。
- [ ] 接入骨架：admin-api 路由组挂在 `/admin-api/*`、与 C 端路由分组隔离；`apps/admin` 独立 token-store（key `bid.admin.token`，与 C 端隔离）+ api-client + 登录页 + RequireAdmin；生产子域 `admin.<域名>` 部署对齐 spec001/007 双子域。
- [ ] 测试要点全覆盖：admin 登录签发独立会话；`requireAdmin(role)` 拒绝越权角色返回 403；`writeAudit` 记录前后值；**C 端 token 不能访问 admin-api**（401）。
- [ ] 种子：`seedAdminRoles` + `seedSuperadmin`（env 注入、幂等）；首个 superadmin 建后可登录。
- [ ] `bun test`（App API 集成 + admin 前端单测）+ `typecheck` 全绿；迁移可复跑；`main` 上先开分支 `phase3/spec309-admin-foundation` 再改，合并附 Co-Authored-By。
