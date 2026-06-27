# spec207 · App 全流程编排接入（★里程碑） 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** App 层（Hono+Bun+Drizzle）把投标全流程编排起来：一本标书 = 一个 `bid_projects` 行（持有 `thread_id`）；C 端每"推进一步"（读标/提纲/正文/审查/述标/导出）→ App **预扣 stub → 建 agent run（带同 `thread_id`）→ 调 `agent_type="bidding_agent"` → SSE 中继进度 → 落库该步结果 → settle stub（消费 `agent_token_usage` 汇总）**。接 C 端 `/read`/`/outline`/`/content`/`/risk`/`/present` 五页 + 产物（`.docx`/`.pptx`）下载。**完成「上传招标文件 → 商务标/技术标 → 完整标书 + 述标 PPT」全链路，agent 完全接住。**

**Architecture:** 扩 spec108（Phase 1 的读标编排）到多步：`bid_projects`（thread_id/状态/当前步）+ `project_steps`（每步结果 JSONB + 计费记录）。每步 API：`POST /api/projects/:id/steps/:step` → 预扣 → 调 Agent Service `POST /agents/bidding_agent/runs {thread_id, input}` → 中继 `/runs/:rid/stream` 的 SSE → 完成后存结果 + settle。产物经 Agent Service 落 MinIO（spec205/206），App 发**预签名下载 URL**。

**Tech Stack:** Hono 4.12、Bun、Drizzle ORM、PostgreSQL（public schema）、Zod、MinIO SDK、SSE。

## Global Constraints

承接 Phase 0/1（见各 index）。本 spec 关键：
- **钱只在 App**（§3.2）：预扣/结算用 **stub**（Phase 3 接真账本）；Agent Service 只上报 usage。
- App **对 Agent 内部无知**：只发 `{agent_type, thread_id, input, file_key}`，按 `run_id` 关联用量；不知道"节点/子agent"。
- 一本标书一个 `thread_id`；每步一个 `run_id`（与 spec201 模型一致）。
- 产物二进制不过 App：Agent 落 MinIO，App 只发**预签名 URL**。
- TDD（bun test）；`main` 上先开分支；提交信息附 Co-Authored-By。

---

## File Structure

```
apps/api/src/
├── db/schema/bid-projects.ts       # 新：bid_projects / project_steps 表
├── routes/projects.ts              # 新：建项目/上传招标文件/按步推进/SSE/产物下载
├── services/agent-client.ts        # 改：扩 createRun 支持 thread_id + step；relayStream
├── services/billing-stub.ts        # 改/新：preDeduct(step)/settle(runId) stub
└── lib/minio.ts                    # 改：presignedGetUrl(key)
apps/api/test/
├── projects.steps.test.ts          # 新：按步推进 + 计费 stub 调用次序
└── projects.artifacts.test.ts      # 新：产物下载发预签名 URL
apps/web/app/(tool)/                 # 改：/read /outline /content /risk /present 接真实接口（占位→联调）
```

---

## Interfaces

- Consumes：Agent Service run 契约（spec104：`POST /agents/{type}/runs`、`/runs/:id/stream`、`/runs/:id`）；spec205/206 产物 key（`artifacts.docx/pptx`）；spec102 `agent_token_usage`。
- Produces：
  - 表 `bid_projects { id, user_id, thread_id, tender_file_key, status, current_step, created_at }`。
  - 表 `project_steps { id, project_id, step, run_id, result(jsonb), cost_points, status, created_at }`。
  - API：`POST /api/projects`、`POST /api/projects/:id/steps/:step`、`GET /api/projects/:id/stream`、`GET /api/projects/:id`、`GET /api/projects/:id/artifacts/:kind`。
  - `STEP_ORDER = ["read","outline","content","review","present","export"]`（与 agent 节点序一致）。

---

## Task 1: 数据模型（bid_projects / project_steps）

**Files:** Create `apps/api/src/db/schema/bid-projects.ts`；Create migration；Create `apps/api/test/projects.schema.test.ts`

- [ ] **Step 1: 开分支**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout -b phase2/spec207-app-orchestration
```

- [ ] **Step 2: 写 `db/schema/bid-projects.ts`**

```typescript
import { pgTable, uuid, text, jsonb, integer, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./users";

export const bidProjects = pgTable("bid_projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  threadId: text("thread_id").notNull().unique(),     // 一本标书一个 thread（贯穿 agent 工作流）
  tenderFileKey: text("tender_file_key"),             // 招标文件 MinIO key
  status: text("status").notNull().default("draft"),  // draft/running/done
  currentStep: text("current_step").default("read"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({ userIdx: index("bid_projects_user_idx").on(t.userId) }));

export const projectSteps = pgTable("project_steps", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => bidProjects.id),
  step: text("step").notNull(),                       // read/outline/content/review/present/export
  runId: text("run_id"),                              // 关联 agent run（按步一个）
  result: jsonb("result"),                            // 该步结构化结果（ReadResult/Outline/...）
  costPoints: integer("cost_points").default(0),      // 计费 stub 记账
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({ projIdx: index("project_steps_proj_idx").on(t.projectId) }));
```

- [ ] **Step 3: 生成迁移 + 失败测试**

```bash
cd apps/api && bun run drizzle-kit generate
```
`test/projects.schema.test.ts`：建项目 + 加一步，断言 thread_id 唯一、step 外键。

- [ ] **Step 4: 通过 + 提交**

Run: `cd apps/api && bun test test/projects.schema.test.ts`
```bash
git add apps/api/src/db/schema/bid-projects.ts apps/api/drizzle apps/api/test/projects.schema.test.ts
git commit -m "feat(spec207): bid_projects/project_steps 表(一本标书=一个 thread_id)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 计费 stub + agent-client 扩展（thread_id + step）

**Files:** Modify `apps/api/src/services/billing-stub.ts`、`apps/api/src/services/agent-client.ts`；Create `apps/api/test/billing-stub.test.ts`

- [ ] **Step 1: `billing-stub.ts`——按步预扣/结算 stub**

```typescript
// 每步消耗积分（Phase 3 接真账本；此处只记账到 project_steps.cost_points）
export const STEP_COST: Record<string, number> = {
  read: 10, outline: 8, content: 30, review: 8, present: 12, export: 2,
};

export async function preDeduct(step: string): Promise<{ ok: boolean; hold: number }> {
  // TODO(Phase3): 校验余额并冻结。stub: 永远放行，返回应扣额度
  return { ok: true, hold: STEP_COST[step] ?? 0 };
}

export async function settle(runId: string, hold: number): Promise<number> {
  // TODO(Phase3): 读 agent_token_usage 汇总该 run 实际用量换算积分，多退少补。
  // stub: 直接按 hold 结算
  return hold;
}
```

- [ ] **Step 2: `agent-client.ts`——createRun 带 thread_id/step + relayStream**

```typescript
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
    yield dec.decode(value);                          // 透传 SSE 分片给前端
  }
}

export async function getRun(runId: string) {
  const r = await fetch(`${AGENT_BASE}/runs/${runId}`);
  return (await r.json()) as { status: string; result?: unknown };
}
```

- [ ] **Step 3: 失败测试 `test/billing-stub.test.ts`**

断言 `preDeduct("content").hold === 30`；`settle("r1", 30) === 30`。

- [ ] **Step 4: 通过 + 提交**

```bash
cd apps/api && bun test test/billing-stub.test.ts
git add apps/api/src/services/billing-stub.ts apps/api/src/services/agent-client.ts apps/api/test/billing-stub.test.ts
git commit -m "feat(spec207): 按步计费 stub + agent-client(thread_id/step/relayStream)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 按步推进编排（routes/projects.ts）

**Files:** Create `apps/api/src/routes/projects.ts`；Modify `apps/api/src/app.ts`（挂路由）；Create `apps/api/test/projects.steps.test.ts`

- [ ] **Step 1: 写 `routes/projects.ts`（建项目 + 按步推进 + SSE + 查询）**

```typescript
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { db } from "../db";
import { bidProjects, projectSteps } from "../db/schema/bid-projects";
import { eq, and } from "drizzle-orm";
import { preDeduct, settle } from "../services/billing-stub";
import { createRun, relayStream, getRun } from "../services/agent-client";

export const STEP_ORDER = ["read", "outline", "content", "review", "present", "export"] as const;

export const projects = new Hono();

// 建项目（上传招标文件后拿到 file_key 调此）
projects.post("/", async (c) => {
  const { fileKey } = z.object({ fileKey: z.string() }).parse(await c.req.json());
  const userId = c.get("userId");                      // 鉴权中间件注入（Phase 0）
  const threadId = `proj-${crypto.randomUUID()}`;
  const [p] = await db.insert(bidProjects)
    .values({ userId, threadId, tenderFileKey: fileKey }).returning();
  return c.json({ id: p.id, threadId: p.threadId });
});

// 推进一步：预扣 → 建 run（同 thread）→ 中继 SSE → 完成存结果 + settle
projects.post("/:id/steps/:step", async (c) => {
  const { id, step } = c.req.param();
  if (!STEP_ORDER.includes(step as any)) return c.json({ error: "bad step" }, 400);
  const [p] = await db.select().from(bidProjects).where(eq(bidProjects.id, id));
  if (!p) return c.json({ error: "not found" }, 404);

  const hold = await preDeduct(step);
  if (!hold.ok) return c.json({ error: "insufficient" }, 402);

  const input = step === "read" ? { file_key: p.tenderFileKey, step } : { step };
  const { run_id } = await createRun({ agentType: "bidding_agent", threadId: p.threadId, input });
  const [s] = await db.insert(projectSteps)
    .values({ projectId: id, step, runId: run_id, status: "running" }).returning();

  return streamSSE(c, async (stream) => {
    for await (const chunk of relayStream(run_id)) await stream.write(chunk);
    const run = await getRun(run_id);                  // 取该步结构化结果
    const cost = await settle(run_id, hold.hold);
    await db.update(projectSteps)
      .set({ result: run.result ?? null, status: "done", costPoints: cost })
      .where(eq(projectSteps.id, s.id));
    const next = STEP_ORDER[STEP_ORDER.indexOf(step as any) + 1];
    await db.update(bidProjects).set({ currentStep: next ?? "done", status: next ? "running" : "done" })
      .where(eq(bidProjects.id, id));
    await stream.writeSSE({ event: "step.done", data: JSON.stringify({ step, cost }) });
  });
});

// 查项目 + 各步结果（前端各页渲染）
projects.get("/:id", async (c) => {
  const [p] = await db.select().from(bidProjects).where(eq(bidProjects.id, c.req.param("id")));
  if (!p) return c.json({ error: "not found" }, 404);
  const steps = await db.select().from(projectSteps).where(eq(projectSteps.projectId, p.id));
  return c.json({ project: p, steps });
});
```

- [ ] **Step 2: 挂路由** `app.route("/api/projects", projects)`（带鉴权中间件）。

- [ ] **Step 3: 失败测试 `test/projects.steps.test.ts`（mock agent-client + billing）**

```typescript
// mock createRun→{run_id}, relayStream→几条分片, getRun→{result:{categories:[...]}}
// 断言：POST /steps/read 调用 preDeduct 一次、createRun 带 threadId、结束写 project_steps.result、currentStep→outline
```
要点断言：
- `createRun` 收到 `{ agentType: "bidding_agent", threadId: p.threadId }`；
- read 步 input 含 `file_key`；
- 结束后 `project_steps.status==="done"` 且 `result` 落库；`bid_projects.current_step==="outline"`。

- [ ] **Step 4: 通过 + 提交**

```bash
cd apps/api && bun test test/projects.steps.test.ts
git add apps/api/src/routes/projects.ts apps/api/src/app.ts apps/api/test/projects.steps.test.ts
git commit -m "feat(spec207): 按步推进编排(预扣→run(同thread)→SSE中继→存结果→settle)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 产物下载（预签名 URL）

**Files:** Modify `apps/api/src/lib/minio.ts`、`apps/api/src/routes/projects.ts`；Create `apps/api/test/projects.artifacts.test.ts`

- [ ] **Step 1: `lib/minio.ts` 加 `presignedGetUrl(key, expirySec=300)`**

```typescript
export async function presignedGetUrl(key: string, expirySec = 300): Promise<string> {
  return await minio.presignedGetObject(BUCKET, key, expirySec);
}
```

- [ ] **Step 2: `routes/projects.ts` 加产物下载**

```typescript
// :kind = docx | pptx，从 present/export 步的 result.artifacts 取 key
projects.get("/:id/artifacts/:kind", async (c) => {
  const { id, kind } = c.req.param();
  const steps = await db.select().from(projectSteps).where(eq(projectSteps.projectId, id));
  const key = steps
    .map((s) => (s.result as any)?.artifacts?.[kind])
    .find((k) => typeof k === "string");
  if (!key) return c.json({ error: "artifact not ready" }, 404);
  return c.json({ url: await presignedGetUrl(key) });   // 前端用此 URL 直下 MinIO
});
```

- [ ] **Step 3: 失败测试 `test/projects.artifacts.test.ts`**

断言：present 步 result 含 `artifacts.pptx` → `GET /artifacts/pptx` 返回 `{ url }`（mock `presignedGetUrl`）；无产物 → 404。

- [ ] **Step 4: 通过 + 提交**

```bash
cd apps/api && bun test test/projects.artifacts.test.ts
git add apps/api/src/lib/minio.ts apps/api/src/routes/projects.ts apps/api/test/projects.artifacts.test.ts
git commit -m "feat(spec207): 产物下载(.docx/.pptx 预签名 URL)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: C 端五页联调 + 端到端 + 合并

**Files:** Modify `apps/web/app/(tool)/{read,outline,content,risk,present}/page.tsx`（占位数据 → 真实接口）

- [ ] **Step 1: 各页接真实接口**（替换原型 `sample-bid.ts` 占位）

| 页面 | 调用 | 渲染 |
|---|---|---|
| `/read` | `POST /steps/read` + SSE | 六大分类 + 废标风险（`ReadResult`） |
| `/outline` | `POST /steps/outline` | 技术标/商务标提纲树（`Outline`） |
| `/content` | `POST /steps/content` + 右栏改写调 `POST /steps/content`（带 chapter 指令） | 三栏正文（`chapters`） |
| `/risk` | `POST /steps/review` | 体检分 + 风险项（`RiskReport`） |
| `/present` | `POST /steps/present` → `GET /artifacts/pptx` | 述标稿 + 下载 PPT（`DeckSpec`） |
| 导出 | `POST /steps/export` → `GET /artifacts/docx` | 下载完整标书 |

> 前端类型直接复用原型已定义的 TS 类型（与 agent schema 同构），仅把数据源从 `sample-bid.ts` 换成接口返回。

- [ ] **Step 2: 端到端冒烟（配 Key）**

```
上传招标文件 → /read → /outline → /content（商务标+技术标）→ /risk → /present（下载 .pptx）→ 导出（下载 .docx）
```
Expected: 同一 `thread_id` 贯穿；每步独立 `run_id` + `project_steps` 落账；两份产物可下载打开。

- [ ] **Step 3: 全量 + 合并**

```bash
cd apps/api && bun test
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout main && git merge --no-ff phase2/spec207-app-orchestration -m "merge spec207: App 全流程编排接入(★全流程闭环里程碑)"
git push origin main
```

---

## 验收清单（spec207 = Phase 2 全流程闭环里程碑）

- [ ] `bid_projects`（thread_id）+ `project_steps`（每步 run/result/计费）落库。
- [ ] 按步 API：预扣 stub → 建 run（同 thread_id，agent_type=bidding_agent）→ SSE 中继 → 存结果 → settle stub。
- [ ] 一本标书一个 `thread_id`，每步一个 `run_id`；step 序与 agent 节点序一致。
- [ ] 产物 `.docx`/`.pptx` 经 MinIO 预签名 URL 下载，二进制不过 App。
- [ ] C 端五页 + 导出全部接真实接口；端到端「上传→商务标/技术标→完整标书+述标PPT」跑通。
- [ ] 钱只在 App（预扣/结算 stub）；Agent 只上报 usage；`bun test` 全绿。
