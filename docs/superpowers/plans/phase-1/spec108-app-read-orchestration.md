# spec108 · App 编排接入：上传 → 读标 端到端（★Phase 1 里程碑） 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Phase 1 串成端到端：C 端上传招标文件（spec006 → MinIO key）→ App **预扣 stub → 建 agent run（`agent_type="bidding_agent"`，带 `thread_id` + `file_key`）→ 调 Agent Service → SSE 中继读标进度 → 落库结果（六大分类）→ settle stub（汇总 `agent_token_usage`）** → C 端 `/read` 渲染。建立 **`agent_runs`** 通用桥接表（App 侧每个 run 一行，靠 `run_id` 关联 `agent.*` 观测）。**这是 Phase 1 最关键里程碑**：证明 App↔Agent 编排缝（预扣/建run/中继/结算）打通；Phase 2（spec207）在此之上扩成多步全流程。

**Architecture:** App 不知道 agent 内部节点，只发 `{agent_type, thread_id, input}`。`agent-client.ts` 封装 Agent Service 的 run 契约（spec104：`POST /agents/{type}/runs`、`/runs/:id/stream`、`/runs/:id`）。`billing-stub.ts` 的 `preDeduct/settle` 是占位（Phase 3 接真账本），但 `settle` 真去 `agent_token_usage` 汇总该 run 用量（消费路径打通）。读标结果存 `agent_runs.result`（JSONB），`/read` 直接渲染。

**Tech Stack:** Hono 4.12、Bun、Drizzle ORM、PostgreSQL（public schema）、Zod、SSE。

## Global Constraints

见 `spec100-index.md`。本 spec 关键：
- **钱只在 App**（§3.2）：`preDeduct/settle` stub；Agent 只上报 usage。
- App 对 Agent 内部无知：只发 `{agent_type, thread_id, input, file_key}`，按 `run_id` 关联用量。
- 一本标书一个 `thread_id`；读标一个 `run_id`（与 spec201/207 模型一致，Phase 2 复用同套 client/billing）。
- TDD（bun test，mock agent-client）；`main` 上先开分支；提交信息附 Co-Authored-By。

---

## File Structure

```
apps/api/src/
├── db/schema/agent-runs.ts        # 新：agent_runs 通用桥接表
├── db/schema/observability.ts     # 新：agent.agent_token_usage 只读映射（settle 汇总用，对齐 spec102）
├── services/agent-client.ts       # 新：createRun / relayStream / getRun（Agent Service run 契约）
├── services/billing-stub.ts       # 新：preDeduct(step)/settle(runId,hold)（占位 + 汇总 usage）
├── routes/read.ts                 # 新：POST /api/read（编排）+ GET /api/runs/:id
└── app.ts                         # 改：挂 /api 路由
apps/api/test/
├── agent-runs.schema.test.ts      # 新：表往返
└── read.flow.test.ts              # 新：编排次序（预扣→createRun→SSE→存结果→settle）
apps/web/app/(tool)/read/page.tsx  # 改：占位数据 → 真实接口
```

---

## Interfaces（供 spec207 复用/扩展）

- Produces：
  - 表 `agent_runs { id, userId, agentType, runId, threadId, status, costPoints, result(jsonb), createdAt }`。
  - `createRun({agentType, threadId, input}) -> {run_id}`、`relayStream(runId) -> AsyncGenerator<string>`、`getRun(runId) -> {status, result?}`。
  - `preDeduct(step) -> {ok, hold}`、`settle(runId, hold) -> number`（spec207 扩 STEP_COST 复用同文件）。
  - API：`POST /api/read {fileKey}`（SSE）、`GET /api/runs/:id`。

---

## Task 1: agent_runs 桥接表

**Files:** Create `apps/api/src/db/schema/agent-runs.ts`、migration、`apps/api/test/agent-runs.schema.test.ts`

- [ ] **Step 1: 开分支**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout -b phase1/spec108-app-read-orchestration
```

- [ ] **Step 2: 写 `db/schema/agent-runs.ts`**

```typescript
import { pgTable, uuid, text, jsonb, integer, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./users";

// App 侧每个 agent run 一行；与 agent.* 观测表靠 runId 关联（§4.7）
export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  agentType: text("agent_type").notNull(),            // "bidding_agent"
  runId: text("run_id").notNull().unique(),           // Agent Service 返回的 run_id
  threadId: text("thread_id").notNull(),              // 会话键（一本标书）
  status: text("status").notNull().default("running"),// running/done/failed
  costPoints: integer("cost_points").default(0),      // 计费 stub 记账
  result: jsonb("result"),                            // 该 run 结构化结果（如 ReadResult）
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({ userIdx: index("agent_runs_user_idx").on(t.userId) }));
```

- [ ] **Step 3: 生成迁移 + 失败测试**

```bash
cd apps/api && bun run drizzle-kit generate
```
`test/agent-runs.schema.test.ts`：插入一行（runId 唯一）→ 查回 → 断言 `agentType==="bidding_agent"`、`runId` 唯一冲突报错。

- [ ] **Step 4: 通过 + 提交**

Run: `cd apps/api && bun test test/agent-runs.schema.test.ts`
```bash
git add apps/api/src/db/schema/agent-runs.ts apps/api/drizzle apps/api/test/agent-runs.schema.test.ts
git commit -m "feat(spec108): agent_runs 桥接表(App 侧 run 账, runId 关联观测)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: agent-client + billing-stub

**Files:** Create `apps/api/src/services/agent-client.ts`、`apps/api/src/db/schema/observability.ts`、`apps/api/src/services/billing-stub.ts`、`apps/api/test/billing-stub.test.ts`

- [ ] **Step 1: 写 `services/agent-client.ts`**

```typescript
const AGENT_BASE = process.env.AGENT_BASE_URL ?? "http://localhost:8090";

export async function createRun(opts: { agentType: string; threadId: string; input: unknown }) {
  const r = await fetch(`${AGENT_BASE}/agents/${opts.agentType}/runs`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ thread_id: opts.threadId, input: opts.input }),
  });
  if (!r.ok) throw new Error(`agent createRun ${r.status}`);
  return (await r.json()) as { run_id: string };
}

export async function* relayStream(runId: string): AsyncGenerator<string> {
  const r = await fetch(`${AGENT_BASE}/runs/${runId}/stream`);
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    yield dec.decode(value);                            // 透传 SSE 分片给前端
  }
}

export async function getRun(runId: string) {
  const r = await fetch(`${AGENT_BASE}/runs/${runId}`);
  return (await r.json()) as { status: string; result?: unknown };
}
```

- [ ] **Step 1.5: 写 `db/schema/observability.ts`（只读映射 agent.agent_token_usage）**

billing-stub 的 `settle` 要汇总该 run 的 token 用量，需 import `agentTokenUsage`。该表是 Agent 侧 spec102 在 `agent` schema 下建的，App 这里只做 **drizzle 只读映射**（不建表、不迁移），列名对齐 spec102，仅声明 settle 汇总用到的列。

```typescript
import { pgSchema, uuid, bigint, timestamp } from "drizzle-orm/pg-core";

// agent.* 由 Agent 侧（spec102）建表/迁移；App 仅只读映射，列名对齐 spec102
const agent = pgSchema("agent");

export const agentTokenUsage = agent.table("agent_token_usage", {
  runId: uuid("run_id").notNull(),                    // 关联 Agent Service run_id
  totalTokens: bigint("total_tokens", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  // 只声明 settle 汇总用到的列；其余列（prompt/completion 等）按需补，命名对齐 spec102
});
```
> 若 `run_id` 在 spec102 实际为 `text` 而非 `uuid`，以 spec102 列定义为准对齐类型；本映射只读，不参与迁移。

- [ ] **Step 2: 写 `services/billing-stub.ts`**

```typescript
import { db } from "../db";
import { agentTokenUsage } from "../db/schema/observability";   // spec102 的 agent.agent_token_usage（只读汇总）
import { eq, sql } from "drizzle-orm";

// 每步消耗积分（Phase 3 接真账本）；Phase 1 只读标这一档
export const STEP_COST: Record<string, number> = { read: 10 };

export async function preDeduct(step: string): Promise<{ ok: boolean; hold: number }> {
  // TODO(Phase3): 校验余额并冻结。stub：放行，返回应扣额度
  return { ok: true, hold: STEP_COST[step] ?? 0 };
}

export async function settle(runId: string, hold: number): Promise<number> {
  // 真去汇总该 run 实际 token 用量（消费路径打通）；积分换算 Phase 3 接真账本，此处 stub 按 hold 结算
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${agentTokenUsage.totalTokens}), 0)` })
    .from(agentTokenUsage)
    .where(eq(agentTokenUsage.runId, runId));
  // 可据 row.total 做计量日志；stub 返回 hold
  void row;
  return hold;
}
```

> `agentTokenUsage` 来自上面 Step 1.5 的 `db/schema/observability.ts`（drizzle 只读映射 spec102 已建的 `agent.agent_token_usage`）。settle 汇总仅做计量日志，积分换算 Phase 3 接真账本，此处按 hold 结算。

- [ ] **Step 3: 失败测试 `test/billing-stub.test.ts`**

`preDeduct("read")` → `{ ok:true, hold:10 }`；`settle(runId, 10)`（mock db usage sum）→ `10`。

- [ ] **Step 4: 通过 + 提交**

```bash
cd apps/api && bun test test/billing-stub.test.ts
git add apps/api/src/services/agent-client.ts apps/api/src/db/schema/observability.ts apps/api/src/services/billing-stub.ts apps/api/test/billing-stub.test.ts
git commit -m "feat(spec108): agent-client(run 契约) + billing-stub(预扣/结算占位+汇总usage)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: /api/read 编排（预扣 → 建 run → SSE 中继 → 存结果 → settle）

**Files:** Create `apps/api/src/routes/read.ts`；Modify `apps/api/src/app.ts`；Create `apps/api/test/read.flow.test.ts`

- [ ] **Step 1: 写 `routes/read.ts`**

```typescript
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { db } from "../db";
import { agentRuns } from "../db/schema/agent-runs";
import { eq } from "drizzle-orm";
import { preDeduct, settle } from "../services/billing-stub";
import { createRun, relayStream, getRun } from "../services/agent-client";

export const read = new Hono();

// 上传招标文件后（已有 fileKey）触发读标
read.post("/", async (c) => {
  const { fileKey } = z.object({ fileKey: z.string() }).parse(await c.req.json());
  const userId = c.get("userId");                       // Phase 0 鉴权中间件注入
  const threadId = `proj-${crypto.randomUUID()}`;

  const hold = await preDeduct("read");
  if (!hold.ok) return c.json({ error: "insufficient" }, 402);

  const { run_id } = await createRun({
    agentType: "bidding_agent", threadId,
    // 契约统一 { text, file_key, step }：text 为按步指令，避免 agent 端 input.get("text") 落空
    input: { text: `请对招标文件读标，key=${fileKey}`, file_key: fileKey, step: "read" },
  });
  await db.insert(agentRuns).values({ userId, agentType: "bidding_agent", runId: run_id, threadId, status: "running" });

  return streamSSE(c, async (stream) => {
    for await (const chunk of relayStream(run_id)) await stream.write(chunk);
    const run = await getRun(run_id);                   // 取六大分类结果
    const cost = await settle(run_id, hold.hold);
    await db.update(agentRuns)
      .set({ status: "done", result: run.result ?? null, costPoints: cost })
      .where(eq(agentRuns.runId, run_id));
    await stream.writeSSE({ event: "done", data: JSON.stringify({ runId: run_id, cost }) });
  });
});

read.get("/runs/:id", async (c) => {
  const [row] = await db.select().from(agentRuns).where(eq(agentRuns.runId, c.req.param("id")));
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);                                    // 前端 /read 渲染 row.result
});
```

- [ ] **Step 2: 挂路由** `app.route("/api/read", read)`（带鉴权中间件）。

- [ ] **Step 3: 失败测试 `test/read.flow.test.ts`（mock agent-client + billing）**

要点断言：
- `POST /api/read {fileKey}` → `preDeduct("read")` 调一次；
- `createRun` 收到 `{ agentType: "bidding_agent", threadId, input:{text:`请对招标文件读标，key=…`, file_key, step:"read"} }`（契约统一含 text）；
- 结束后 `agent_runs.status==="done"`、`result` 落库、`costPoints===10`；
- SSE 末尾发 `event: done`。

```typescript
// mock: createRun→{run_id:"r1"}; relayStream→["data: 进度\n\n"]; getRun→{result:{categories:[...]}}
// 注入 mock 后 fetch SSE，收集事件，断言上述
```

- [ ] **Step 4: 通过 + 提交**

```bash
cd apps/api && bun test test/read.flow.test.ts
git add apps/api/src/routes/read.ts apps/api/src/app.ts apps/api/test/read.flow.test.ts
git commit -m "feat(spec108): /api/read 编排(预扣→建run→SSE中继→存结果→settle)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 接 C 端 /read + 真实端到端 + 合并

**Files:** Modify `apps/web/app/(tool)/read/page.tsx`

- [ ] **Step 1: `/read` 页接真实接口**

把原型 `sample-bid.ts` 占位换成：上传后调 `POST /api/read` 订阅 SSE 看进度，完成后 `GET /api/read/runs/:id` 取 `result`（`ReadResult`）渲染六大分类 + 废标风险。前端类型复用原型已定义的 TS（与 agent `ReadResult` 同构）。

- [ ] **Step 2: 真实端到端冒烟（需 DeepSeek Key + Agent Service 跑起）**

```
上传招标文件 → /api/read → SSE 进度 → /read 显示六大分类 + 废标红线
```
Expected: `agent_runs` 落一行（status=done、result 有六大分类、costPoints=10）；`agent.agent_token_usage` 有该 run 用量（spec102）。
> 无 Key 时跳过；mock 流程测试已覆盖编排链路。

- [ ] **Step 3: 全量 + 合并**

```bash
cd apps/api && bun test
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout main && git merge --no-ff phase1/spec108-app-read-orchestration -m "merge spec108: App 读标编排(★Phase 1 里程碑)"
git push origin main
```

---

## 验收清单（spec108 = Phase 1 里程碑）

- [ ] `agent_runs` 桥接表落库（runId 唯一，关联观测）。
- [ ] `agent-client`（createRun/relayStream/getRun）+ `billing-stub`（preDeduct/settle，settle 汇总 usage）就位，spec207 可复用扩展。
- [ ] `POST /api/read`：预扣 stub → 建 run（bidding_agent + thread_id + file_key）→ SSE 中继 → 存 `result` → settle stub。
- [ ] C 端 `/read` 接真实接口；端到端「上传招标文件 → AI 读标」跑通（配 Key）。
- [ ] 钱只在 App（stub）；Agent 只上报 usage；`bun test` 全绿（mock 覆盖编排）。
