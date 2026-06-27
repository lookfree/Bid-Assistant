# spec002 · App API 骨架（Hono + Bun） 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `apps/api` 建立 Hono + Bun 的 App API 骨架：`GET /healthz` 存活探针、`GET /readyz` 依赖探针（连通 PG16 `bidsaas`）、Zod 校验的环境配置、Drizzle + postgres-js 数据库客户端，全部带 `bun test`。

**Architecture:** Hono 应用用工厂函数 `createApp(deps)` 创建，依赖（如 DB ping）通过参数注入，便于单测不连真库；入口 `index.ts` 用 Bun 原生 `export default { fetch }` 服务。配置集中在 `config/env.ts`（Zod 校验），DB 客户端集中在 `db/client.ts`。

**Tech Stack:** Bun、Hono `4.12.25`、Drizzle ORM + `postgres`(postgres-js)、Zod、`bun:test`。

## Global Constraints

见 `spec000-index.md`。本 spec 关键约束：
- Hono 锁 `4.12.25`；ORM Drizzle + 纯 JS 驱动 `postgres`；校验 Zod。
- 连接只从环境变量读，dev 用 `--env-file=../../.env.bidsaas.local`（不入库）。
- 钱的唯一权威是 App API（本 spec 仅骨架，无计费）。
- TDD：先写失败测试；`bun test` 运行。
- 在 `main` 上先开分支再改；提交信息结尾附 Co-Authored-By。

---

## File Structure

```
apps/api/
├── package.json                 # @bid/api，依赖 hono/drizzle-orm/postgres/zod，devDep drizzle-kit
├── tsconfig.json                # extends ../../tsconfig.base.json
├── drizzle.config.ts            # drizzle-kit 配置（spec003 用迁移，此处先建）
├── src/
│   ├── index.ts                 # 入口：export default { port, fetch }
│   ├── app.ts                   # createApp(deps) 工厂，挂载路由
│   ├── config/env.ts            # Zod 校验的 env（单一权威）
│   ├── db/client.ts             # postgres-js + Drizzle 实例 + pingDb()
│   └── routes/health.ts         # /healthz、/readyz
└── test/
    ├── health.test.ts           # /healthz、/readyz（注入 fake pingDb）
    └── env.test.ts              # env 校验：缺 DATABASE_URL 抛错
```

---

## Interfaces（本 spec 对外产出，供 spec003+ 依赖）

- Produces:
  - `createApp(deps?: AppDeps): Hono` — `AppDeps = { pingDb: () => Promise<boolean> }`，默认用真实 `pingDb`。后续 spec 用 `app.route('/auth', authRouter)` 挂载新路由。
  - `env` — 已校验配置对象，至少含 `env.DATABASE_URL: string`、`env.PORT: number`、`env.NODE_ENV: 'development'|'production'|'test'`。
  - `db` — Drizzle 实例（`apps/api/src/db/client.ts` 导出），spec003 在其上加 schema/迁移。
  - `pingDb(): Promise<boolean>` — 执行 `select 1`，连通返回 true。
  - 入口约定：`apps/api/src/index.ts` 默认导出 `{ port, fetch }`，`bun run api` 启动。

---

## Task 1: apps/api 包 + Hono 工厂 + /healthz（TDD）

**Files:**
- Create: `apps/api/package.json`、`apps/api/tsconfig.json`、`apps/api/src/app.ts`、`apps/api/src/routes/health.ts`、`apps/api/test/health.test.ts`

**Interfaces:**
- Consumes: spec001 的 workspace 根（`bun install` 可识别 `apps/*`）。
- Produces: `createApp(deps?)`、`GET /healthz`。

- [ ] **Step 1: 开分支**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout -b phase0/spec002-app-api
```

- [ ] **Step 2: 写 `apps/api/package.json`**

```json
{
  "name": "@bid/api",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --env-file=../../.env.bidsaas.local run --watch src/index.ts",
    "start": "bun run src/index.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "bun --env-file=../../.env.bidsaas.local run drizzle-kit migrate"
  },
  "dependencies": {
    "hono": "4.12.25",
    "drizzle-orm": "^0.36.0",
    "postgres": "^3.4.5",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "drizzle-kit": "^0.28.0",
    "@types/bun": "latest"
  }
}
```

- [ ] **Step 3: 写 `apps/api/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "hono/jsx" },
  "include": ["src", "test", "drizzle.config.ts"]
}
```

- [ ] **Step 4: 安装依赖**

Run: `bun install`
Expected: 成功，无 native 编译错误。

- [ ] **Step 5: 写失败测试 `apps/api/test/health.test.ts`**

```ts
import { describe, it, expect } from "bun:test"
import { createApp } from "../src/app"

describe("GET /healthz", () => {
  it("returns 200 with status ok", async () => {
    const app = createApp({ pingDb: async () => true })
    const res = await app.request("/healthz")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ok" })
  })
})
```

- [ ] **Step 6: 运行测试确认失败**

Run: `cd apps/api && bun test test/health.test.ts`
Expected: FAIL（`createApp` / `../src/app` 不存在）。

- [ ] **Step 7: 写 `apps/api/src/routes/health.ts`（先只 /healthz）**

```ts
import { Hono } from "hono"

export type HealthDeps = { pingDb: () => Promise<boolean> }

export function healthRoutes(deps: HealthDeps) {
  const r = new Hono()
  r.get("/healthz", (c) => c.json({ status: "ok" }))
  return r
}
```

- [ ] **Step 8: 写 `apps/api/src/app.ts`**

```ts
import { Hono } from "hono"
import { healthRoutes } from "./routes/health"

export type AppDeps = { pingDb: () => Promise<boolean> }

export function createApp(deps: AppDeps) {
  const app = new Hono()
  app.route("/", healthRoutes(deps))
  return app
}
```

- [ ] **Step 9: 运行测试确认通过**

Run: `cd apps/api && bun test test/health.test.ts`
Expected: PASS。

- [ ] **Step 10: 提交**

```bash
git add apps/api
git commit -m "feat(spec002): apps/api Hono 工厂 + /healthz

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 环境配置（Zod）+ 入口（Bun serve）

**Files:**
- Create: `apps/api/src/config/env.ts`、`apps/api/src/index.ts`、`apps/api/test/env.test.ts`

**Interfaces:**
- Produces: `env`（已校验）、入口默认导出 `{ port, fetch }`。

- [ ] **Step 1: 写失败测试 `apps/api/test/env.test.ts`**

```ts
import { describe, it, expect } from "bun:test"
import { parseEnv } from "../src/config/env"

describe("parseEnv", () => {
  it("throws when DATABASE_URL missing", () => {
    expect(() => parseEnv({ PORT: "8080" })).toThrow()
  })
  it("parses valid env with defaults", () => {
    const env = parseEnv({ DATABASE_URL: "postgresql://u:p@h:5432/d" })
    expect(env.DATABASE_URL).toBe("postgresql://u:p@h:5432/d")
    expect(env.PORT).toBe(8080)
    expect(env.NODE_ENV).toBe("development")
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/api && bun test test/env.test.ts`
Expected: FAIL（`parseEnv` 不存在）。

- [ ] **Step 3: 写 `apps/api/src/config/env.ts`**

```ts
import { z } from "zod"

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().url(),
})

export type Env = z.infer<typeof schema>

export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = schema.safeParse(source)
  if (!parsed.success) {
    throw new Error(`环境变量校验失败: ${parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`)
  }
  return parsed.data
}

export const env: Env = parseEnv()
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/api && bun test test/env.test.ts`
Expected: PASS（2 项）。

> 注意：`env.test.ts` 调用 `parseEnv` 时传入显式对象，不依赖进程环境；而模块底部的 `export const env = parseEnv()` 在 import 时执行——测试只 import `parseEnv` 不 import `env`，避免无 DATABASE_URL 时崩。spec 后续代码从 `env` 取值。

- [ ] **Step 5: 写入口 `apps/api/src/index.ts`**

```ts
import { createApp } from "./app"
import { env } from "./config/env"
import { pingDb } from "./db/client"

const app = createApp({ pingDb })

export default { port: env.PORT, fetch: app.fetch }
```

> `db/client.ts` 在 Task 3 创建；本步骤先写入口、Task 3 补 client 后入口即可运行。

- [ ] **Step 6: 提交**

```bash
git add apps/api
git commit -m "feat(spec002): Zod env 校验 + Bun 入口

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Drizzle + PG 客户端 + /readyz（TDD + 真库冒烟）

**Files:**
- Create: `apps/api/src/db/client.ts`、`apps/api/drizzle.config.ts`
- Modify: `apps/api/src/routes/health.ts`（加 /readyz）、`apps/api/test/health.test.ts`（加 /readyz 用例）

**Interfaces:**
- Consumes: `env.DATABASE_URL`、`createApp` 的 `deps.pingDb`。
- Produces: `db`（Drizzle 实例）、`pingDb()`，`GET /readyz`。

- [ ] **Step 1: 给 health 测试加 /readyz 用例（失败测试）**

在 `apps/api/test/health.test.ts` 追加：

```ts
describe("GET /readyz", () => {
  it("returns 200 when db reachable", async () => {
    const app = createApp({ pingDb: async () => true })
    const res = await app.request("/readyz")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ready", db: "up" })
  })
  it("returns 503 when db unreachable", async () => {
    const app = createApp({ pingDb: async () => false })
    const res = await app.request("/readyz")
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ status: "unready", db: "down" })
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/api && bun test test/health.test.ts`
Expected: FAIL（/readyz 返回 404）。

- [ ] **Step 3: 在 `apps/api/src/routes/health.ts` 加 /readyz**

```ts
import { Hono } from "hono"

export type HealthDeps = { pingDb: () => Promise<boolean> }

export function healthRoutes(deps: HealthDeps) {
  const r = new Hono()
  r.get("/healthz", (c) => c.json({ status: "ok" }))
  r.get("/readyz", async (c) => {
    const up = await deps.pingDb().catch(() => false)
    return up
      ? c.json({ status: "ready", db: "up" })
      : c.json({ status: "unready", db: "down" }, 503)
  })
  return r
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/api && bun test test/health.test.ts`
Expected: PASS（healthz + readyz 共 3 项）。

- [ ] **Step 5: 写 `apps/api/src/db/client.ts`**

```ts
import { drizzle } from "drizzle-orm/postgres-js"
import { sql } from "drizzle-orm"
import postgres from "postgres"
import { env } from "../config/env"

// 单连接池；schema 在 spec003 引入并作为第二参数传入 drizzle()
const client = postgres(env.DATABASE_URL, { max: 10 })
export const db = drizzle(client)

export async function pingDb(): Promise<boolean> {
  try {
    await db.execute(sql`select 1`)
    return true
  } catch {
    return false
  }
}
```

- [ ] **Step 6: 写 `apps/api/drizzle.config.ts`（供 spec003 迁移）**

```ts
import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/*",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL! },
})
```

- [ ] **Step 7: 真库冒烟（连 bidsaas）**

Run: `cd apps/api && bun --env-file=../../.env.bidsaas.local -e "import('./src/db/client').then(async m => { console.log('pingDb=', await m.pingDb()) })"`
Expected: 打印 `pingDb= true`（连通 PG16 bidsaas）。

- [ ] **Step 8: 提交**

```bash
git add apps/api
git commit -m "feat(spec002): Drizzle/PG 客户端 + /readyz 依赖探针

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 根脚本 `bun run api` + 端到端冒烟 + 合并

**Files:**
- Modify: 根 `package.json`（加 `api` 脚本）

**Interfaces:**
- Produces: `bun run api` 启动 App API。

- [ ] **Step 1: 根 `package.json` scripts 加 api**

在根 `scripts` 加一行：

```json
"api": "bun --filter @bid/api dev"
```

- [ ] **Step 2: 起服务 + healthz 冒烟**

```bash
bun run api &
sleep 2
curl -s http://localhost:8080/healthz   # 期望 {"status":"ok"}
curl -s http://localhost:8080/readyz    # 期望 {"status":"ready","db":"up"}
kill %1
```
Expected: `/healthz` 返回 ok；`/readyz` 返回 ready/up（真连 bidsaas）。

- [ ] **Step 3: 全量测试 + 类型检查**

Run: `cd apps/api && bun test && bun run typecheck`
Expected: 全部 PASS，类型无错。

- [ ] **Step 4: 提交并合并**

```bash
git add -A
git commit -m "chore(spec002): 根 api 脚本 + 端到端冒烟通过

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git checkout main
git merge --no-ff phase0/spec002-app-api -m "merge spec002: App API 骨架"
git push origin main
```

---

## 验收清单（spec002 完成判据）

- [ ] `bun run api` 启动；`/healthz` 200 `{status:ok}`、`/readyz` 200 `{status:ready,db:up}`（真连 PG16 bidsaas）。
- [ ] `createApp(deps)` 可注入 `pingDb`，单测覆盖 healthz + readyz(up/down) + env 校验。
- [ ] `db` Drizzle 实例 + `pingDb()` 导出，供 spec003 加 schema/迁移。
- [ ] `env` Zod 校验：缺 `DATABASE_URL` 即抛错。
- [ ] `apps/api/drizzle.config.ts` 就位（spec003 用）。
- [ ] `bun test` 与 `typecheck` 全绿。
