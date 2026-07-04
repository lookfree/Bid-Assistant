# 智能体模型运营后台可配 Implementation Plan (spec311)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 agent 用哪个大模型（provider / model / fallbacks）由运营后台可视化配置、即时生效，取代现在 env 写死的默认。

**Architecture:** App API 为权威——模型选择存 `billing_configs` 键 `agent_model`（复用 spec301 `getConfig/setConfig` + spec310 admin 通用 `PUT /plans/configs/:key`，无需新端点）。App 建 run 时读该配置，随 run 请求体下发给 agent；agent 用 per-run 选择覆盖 env 默认（Settings.model_copy），gateway 内部零改动。API Key 仍留 env（敏感），仅"选哪家/哪个模型/兜底链"进 DB。配置缺省时回退 env 默认，向后兼容。

**Tech Stack:** App API（Hono + Bun + Drizzle + bun:test）；Agent（Python 3.12 + uv + FastAPI + pydantic + pytest）；Admin 前端（Next.js + shadcn + bun test）。

## Global Constraints

- 钱的铁律不受影响：agent 仍只上报用量、不碰钱；本特性不涉及积分。
- 提交：英文 Conventional Commits、账号 `lookfree`、**不加 Co-Authored-By**。
- 函数 ≤80 行、文件 ≤800 行、关键方法有注释。
- provider 取值仅 `deepseek` / `qwen` / `glm`（见 `services/agent/src/agent/models/providers.py` 的 `PROVIDERS`）；各自 Key 字段 `deepseek_api_key` / `dashscope_api_key` / `zhipu_api_key`（`KEY_FIELD`）。
- 集成测试连真库 → `./test-on-mbp.sh`；纯函数/单测本机可跑。
- App↔agent 契约当前：App 只发 `{thread_id, input, file_refs}`（`apps/api/src/services/agent-client.ts` ↔ `services/agent/src/agent/routes/runs.py`）。本特性新增可选 `model` 字段。

## 数据流

```
运营后台「智能体模型」→ PUT /admin-api/plans/configs/agent_model  (billing_configs)
                                        │
App API createRun：getAgentModel() 读 agent_model → run 请求体带 model:{provider,model,fallbacks}
                                        │  POST /agents/bidding_agent/runs
Agent routes/runs.py：CreateRunBody.model → dispatch.create_run 存进 runmeta
                                        │
executor.process_run：有 model 则 ModelGateway(settings.model_copy(override)) 否则用单例 _gateway
                                        │
gateway 用 provider/model/fallbacks（zero change）；缺 Key → 明确报错（已有）
```

`agent_model` 配置形状：`{ "provider": "deepseek", "model": null, "fallbacks": "" }`
（`model=null` 用 provider 默认模型；`fallbacks` 形如 `"qwen:qwen-plus,glm:glm-4-flash"`，沿用 `settings.model_fallbacks` 语义。）

## 文件结构

- **App API**
  - Modify `apps/api/src/config/billing-seed.ts` — `BILLING_SEED` 加 `agent_model` 默认。
  - Modify `apps/api/src/services/agent-client.ts` — `createRun` 加可选 `model` 转发；新增 `getAgentModel()` + `AgentModelSelection` 类型。
  - Modify `apps/api/src/routes/read.ts`、`apps/api/src/routes/projects.ts` — 建 run 前 `getAgentModel()` 并传入 `createRun`。
  - Test `apps/api/test/agent-client.test.ts`（新建）。
- **Agent**
  - Modify `services/agent/src/agent/routes/runs.py` — `CreateRunBody.model` + 传入 `create_run`。
  - Modify `services/agent/src/agent/runtime/dispatch.py` — `create_run` 加 `model` 参数并写入 runmeta。
  - Modify `services/agent/src/agent/runtime/executor.py` — `process_run` 读 `model`，按需构造 per-run gateway。
  - Modify `services/agent/src/agent/models/gateway.py` — 新增纯函数 `model_override_to_settings(sel) -> dict`。
  - Test `services/agent/tests/test_model_config.py`（新建）。
- **Admin 前端**
  - Modify `apps/admin/components/admin/plans/plans-client.tsx` — 加「智能体模型」配置分区（读写 `agent_model`）。
  - Test `apps/admin/test/agent-model-view.test.ts`（新建，纯映射逻辑）。
- **Docs**
  - Modify `docs/review-followups.md` — 待办标记完成。
  - Modify `docs/superpowers/plans/phase-3/spec300-index.md` — 登记 spec311。

---

### Task 1: App API — seed `agent_model` 默认配置

**Files:**
- Modify: `apps/api/src/config/billing-seed.ts`
- Test: `apps/api/test/billing-seed.test.ts`（若已存在则加用例；否则新建）

**Interfaces:**
- Produces: `BILLING_SEED.agent_model = { provider: "deepseek", model: null, fallbacks: "" }`，经既有 seed 流程（`onConflictDoNothing`）写入 `billing_configs`。

- [ ] **Step 1: 写失败测试**（断言默认值形状；用既有 seed 常量，纯断言不连库）

```ts
import { test, expect } from "bun:test"
import { BILLING_SEED } from "../src/config/billing-seed"

test("BILLING_SEED 含 agent_model 默认（deepseek / 空模型 / 空兜底）", () => {
  expect(BILLING_SEED.agent_model).toEqual({ provider: "deepseek", model: null, fallbacks: "" })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/api && bun test test/billing-seed.test.ts`
Expected: FAIL（`agent_model` 为 undefined）

- [ ] **Step 3: 加默认值**

在 `apps/api/src/config/billing-seed.ts` 的 `BILLING_SEED` 对象末尾（`payment_poll` 后）加：

```ts
  // 智能体模型选择（spec311）：运营后台可配，覆盖 agent env 默认；API Key 仍在 env。
  // provider ∈ deepseek/qwen/glm；model=null 用 provider 默认模型；fallbacks 形如 "qwen:qwen-plus,glm:glm-4-flash"
  agent_model: { provider: "deepseek", model: null, fallbacks: "" },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/api && bun test test/billing-seed.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/config/billing-seed.ts apps/api/test/billing-seed.test.ts
git commit -m "feat(api): seed agent_model config default (spec311)"
```

---

### Task 2: App API — createRun 下发模型选择

**Files:**
- Modify: `apps/api/src/services/agent-client.ts`
- Modify: `apps/api/src/routes/read.ts`、`apps/api/src/routes/projects.ts`
- Test: `apps/api/test/agent-client.test.ts`（新建）

**Interfaces:**
- Consumes: `getConfig<AgentModelSelection>("agent_model")`（`services/config.ts`，Task 1 的键）。
- Produces:
  - `type AgentModelSelection = { provider?: string; model?: string | null; fallbacks?: string }`
  - `getAgentModel(): Promise<AgentModelSelection | undefined>`
  - `createRun(opts: { agentType: string; threadId: string; input: unknown; model?: AgentModelSelection })` — `model` 存在则进请求体 `model` 字段。

- [ ] **Step 1: 写失败测试**（注入 `fetchImpl` 断言请求体带/不带 model）

```ts
import { test, expect } from "bun:test"
import { createRun } from "../src/services/agent-client"

function fakeFetch(capture: { body?: any }) {
  return (async (_url: string, init: any) => {
    capture.body = JSON.parse(init.body)
    return new Response(JSON.stringify({ run_id: "r1" }), { status: 200 })
  }) as unknown as typeof fetch
}

test("createRun 带 model 时请求体含 model", async () => {
  const cap: { body?: any } = {}
  const orig = globalThis.fetch; globalThis.fetch = fakeFetch(cap)
  try {
    await createRun({ agentType: "bidding_agent", threadId: "t1", input: {}, model: { provider: "qwen", model: "qwen-plus", fallbacks: "" } })
    expect(cap.body).toMatchObject({ thread_id: "t1", model: { provider: "qwen", model: "qwen-plus", fallbacks: "" } })
  } finally { globalThis.fetch = orig }
})

test("createRun 不带 model 时请求体无 model 字段", async () => {
  const cap: { body?: any } = {}
  const orig = globalThis.fetch; globalThis.fetch = fakeFetch(cap)
  try {
    await createRun({ agentType: "bidding_agent", threadId: "t1", input: {} })
    expect("model" in cap.body).toBe(false)
  } finally { globalThis.fetch = orig }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/api && bun test test/agent-client.test.ts`
Expected: FAIL（`createRun` 不接受 `model` / 不转发）

- [ ] **Step 3: 实现**

`apps/api/src/services/agent-client.ts`：顶部 import 加 `import { getConfig } from "./config"`；改 `createRun` 与新增 helper：

```ts
export type AgentModelSelection = { provider?: string; model?: string | null; fallbacks?: string }

/** 读运营后台配置的 agent 模型选择（spec311）；缺省 undefined → 用 agent env 默认。 */
export async function getAgentModel(): Promise<AgentModelSelection | undefined> {
  return getConfig<AgentModelSelection>("agent_model")
}

export async function createRun(opts: { agentType: string; threadId: string; input: unknown; model?: AgentModelSelection }) {
  const body: Record<string, unknown> = { thread_id: opts.threadId, input: opts.input }
  if (opts.model) body.model = opts.model // 有配置才下发；无则 agent 用 env 默认
  const r = await fetch(`${getEnv().AGENT_BASE_URL}/agents/${opts.agentType}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`agent createRun ${r.status}`)
  return (await r.json()) as { run_id: string }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/api && bun test test/agent-client.test.ts`
Expected: PASS（2 用例）

- [ ] **Step 5: 接线两个建 run 处**

`apps/api/src/routes/read.ts` 与 `apps/api/src/routes/projects.ts` 里调用 `createRun(...)` 的地方，改为先读模型再传入：

```ts
import { createRun, getAgentModel } from "../services/agent-client"
// ...建 run 处：
const model = await getAgentModel()
const { run_id } = await createRun({ agentType: "bidding_agent", threadId, input, model })
```

- [ ] **Step 6: typecheck + 提交**

Run: `cd apps/api && bun run typecheck`
Expected: 0 error

```bash
git add apps/api/src/services/agent-client.ts apps/api/src/routes/read.ts apps/api/src/routes/projects.ts apps/api/test/agent-client.test.ts
git commit -m "feat(api): pass admin-configured agent model into run requests (spec311)"
```

---

### Task 3: Agent — run 携带 model 并覆盖 env 默认

**Files:**
- Modify: `services/agent/src/agent/routes/runs.py`
- Modify: `services/agent/src/agent/runtime/dispatch.py`
- Modify: `services/agent/src/agent/runtime/executor.py`
- Modify: `services/agent/src/agent/models/gateway.py`
- Test: `services/agent/tests/test_model_config.py`（新建）

**Interfaces:**
- Produces:
  - `models/gateway.py::model_override_to_settings(sel: dict | None) -> dict` — 把 `{provider,model,fallbacks}` 映射到 Settings 字段 `{model_default_provider, model_default_model, model_fallbacks}`，**丢弃 None/缺失键**（返回可直接喂 `Settings.model_copy(update=...)`）。
  - `routes/runs.py::CreateRunBody.model: RunModelOverride | None`，`RunModelOverride(BaseModel){ provider: str|None; model: str|None; fallbacks: str|None }`。
  - `dispatch.create_run(agent_type, input, thread_id=None, file_refs=None, model=None)` — `model` 写入 runmeta。
- Consumes: `executor.process_run` 从 runmeta 取 `model`，有则构造 per-run gateway。

- [ ] **Step 1: 写失败测试**（纯映射 + 请求体解析）

```python
# services/agent/tests/test_model_config.py
from agent.models.gateway import model_override_to_settings
from agent.routes.runs import CreateRunBody


def test_override_maps_and_drops_none():
    out = model_override_to_settings({"provider": "qwen", "model": None, "fallbacks": "glm:glm-4-flash"})
    assert out == {"model_default_provider": "qwen", "model_fallbacks": "glm:glm-4-flash"}
    # model=None 被丢弃，不覆盖


def test_override_none_returns_empty():
    assert model_override_to_settings(None) == {}


def test_create_run_body_parses_model():
    b = CreateRunBody(input={}, thread_id="t1", model={"provider": "deepseek", "model": "deepseek-chat", "fallbacks": ""})
    assert b.model.provider == "deepseek"
    assert b.model.model == "deepseek-chat"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd services/agent && uv run pytest tests/test_model_config.py -q`
Expected: FAIL（`model_override_to_settings` 未定义 / `CreateRunBody` 无 `model`）

- [ ] **Step 3a: 加纯映射函数**

`services/agent/src/agent/models/gateway.py` 末尾（类外）加：

```python
_OVERRIDE_MAP = {
    "provider": "model_default_provider",
    "model": "model_default_model",
    "fallbacks": "model_fallbacks",
}


def model_override_to_settings(sel: dict | None) -> dict:
    """把 run 携带的 {provider,model,fallbacks} 映射为 Settings 字段；丢弃 None/缺失（spec311）。
    结果可直接喂 Settings.model_copy(update=...) 覆盖 env 默认。"""
    if not sel:
        return {}
    return {_OVERRIDE_MAP[k]: v for k, v in sel.items() if k in _OVERRIDE_MAP and v is not None}
```

- [ ] **Step 3b: 请求体加 model 并传入 dispatch**

`services/agent/src/agent/routes/runs.py`：

```python
class RunModelOverride(BaseModel):
    provider: str | None = None
    model: str | None = None
    fallbacks: str | None = None


class CreateRunBody(BaseModel):
    input: dict
    thread_id: str | None = None
    file_refs: list[str] | None = None
    model: RunModelOverride | None = None  # spec311：App 下发的模型选择，覆盖 env 默认


@router.post("/agents/{agent_type}/runs")
async def create(agent_type: str, body: CreateRunBody):
    model = body.model.model_dump() if body.model else None
    run_id = create_run(agent_type, body.input, body.thread_id, body.file_refs, model)
    return {"run_id": run_id}
```

- [ ] **Step 3c: dispatch 写入 runmeta**

`services/agent/src/agent/runtime/dispatch.py` 的 `create_run` 签名加 `model: dict | None = None`；runmeta 加 `model`：

```python
def create_run(agent_type: str, input: dict, thread_id: str | None = None,
               file_refs: list[str] | None = None, model: dict | None = None) -> str:
    # ...（run_id/tid/insert 不变）...
    r.set(runmeta_key(run_id), json.dumps(
        {"agent_type": agent_type, "thread_id": tid, "input": input, "model": model}), ex=86400)
    r.xadd(stream_key(), {"run_id": run_id})
    return run_id
```

- [ ] **Step 3d: executor 按需 per-run gateway**

`services/agent/src/agent/runtime/executor.py`：import 加 `from agent.models.gateway import ModelGateway, model_override_to_settings` 与 `from agent.config import settings`（若未 import）。在 `process_run` 读 meta 后：

```python
    model = meta.get("model")
    override = model_override_to_settings(model)
    gateway = ModelGateway(settings.model_copy(update=override)) if override else _gateway
    ctx = RunContext(run_id=run_id, agent_type=agent_type, thread_id=thread_id,
                     recorder=rec, gateway=gateway, redis=r)
```

（无 override 时复用模块级单例 `_gateway`，零额外开销；有 override 才新建。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd services/agent && uv run pytest tests/test_model_config.py -q`
Expected: PASS（3 用例）

- [ ] **Step 5: 回归 + 提交**

Run: `cd services/agent && uv run pytest -q`
Expected: 全绿（无回归）

```bash
git add services/agent/src/agent/routes/runs.py services/agent/src/agent/runtime/dispatch.py services/agent/src/agent/runtime/executor.py services/agent/src/agent/models/gateway.py services/agent/tests/test_model_config.py
git commit -m "feat(agent): per-run model override from request body (spec311)"
```

---

### Task 4: Admin 前端 — 「智能体模型」配置分区

**Files:**
- Modify: `apps/admin/components/admin/plans/plans-client.tsx`
- Test: `apps/admin/test/agent-model-view.test.ts`（新建）

**Interfaces:**
- Consumes: `GET /admin-api/plans/configs`（返回含 `agent_model`）、`PUT /admin-api/plans/configs/agent_model`（body `{ value: { provider, model, fallbacks } }`，需 `config.write` 权限）——两端点 spec310 已存在，无需改后端。
- Produces（纯逻辑，抽到组件同文件或 `lib`，供测试）：
  - `type AgentModelForm = { provider: string; model: string; fallbacks: string }`
  - `toAgentModelForm(cfg: unknown): AgentModelForm` — 把 config 值（`model` 可能为 null）规整成表单（null→""）。
  - `fromAgentModelForm(f: AgentModelForm): { provider: string; model: string | null; fallbacks: string }` — 空 model→null。

- [ ] **Step 1: 写失败测试**（纯映射）

```ts
import { test, expect } from "bun:test"
import { toAgentModelForm, fromAgentModelForm } from "../components/admin/plans/plans-client"

test("toAgentModelForm：null 模型规整为空串", () => {
  expect(toAgentModelForm({ provider: "deepseek", model: null, fallbacks: "" }))
    .toEqual({ provider: "deepseek", model: "", fallbacks: "" })
})

test("fromAgentModelForm：空模型回写 null", () => {
  expect(fromAgentModelForm({ provider: "qwen", model: "", fallbacks: "glm:glm-4-flash" }))
    .toEqual({ provider: "qwen", model: null, fallbacks: "glm:glm-4-flash" })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/admin && bun test test/agent-model-view.test.ts`
Expected: FAIL（函数未定义）

- [ ] **Step 3: 实现映射 + 分区 UI**

在 `plans-client.tsx` 导出上述两个纯函数；新增「智能体模型」卡片：provider 用 `<select>`（选项 `deepseek`/`qwen`/`glm`）、model 与 fallbacks 用 `<Input>`，保存调 `adminApi PUT /plans/configs/agent_model`（沿用页面既有配置保存模式与 `config.write` 按钮禁用逻辑）。model 展示用 `toAgentModelForm`，保存用 `fromAgentModelForm`。

- [ ] **Step 4: 跑测试 + typecheck**

Run: `cd apps/admin && bun test test/agent-model-view.test.ts && bun run typecheck`
Expected: PASS + 0 error

- [ ] **Step 5: 提交**

```bash
git add apps/admin/components/admin/plans/plans-client.tsx apps/admin/test/agent-model-view.test.ts
git commit -m "feat(admin): agent model config section on plans page (spec311)"
```

---

### Task 5: Docs — 台账与索引

**Files:**
- Modify: `docs/review-followups.md`（把「agent 模型改为运营后台可配」待办标记完成，指向 spec311）
- Modify: `docs/superpowers/plans/phase-3/spec300-index.md`（登记 spec311：目标 + 依赖 spec301 配置机制 / spec310 admin 配置端点 / Phase 1-2 agent 网关）

- [ ] **Step 1: 更新两份文档**（把待办标记 done、索引加一行）
- [ ] **Step 2: 提交**

```bash
git add docs/review-followups.md docs/superpowers/plans/phase-3/spec300-index.md
git commit -m "docs: mark agent-model-config done, index spec311"
```

---

## 验证（全部任务后，作为部署前门禁）

- App API：`./test-on-mbp.sh test/agent-client.test.ts test/billing-seed.test.ts` 绿 + `bun run typecheck` 0 error。
- Agent：`cd services/agent && uv run pytest -q` 全绿。
- Admin：`cd apps/admin && bun test && bun run typecheck`。
- 端到端（部署后在 mbp 开发环境）：运营后台「智能体模型」把 provider 从 deepseek 切到 qwen（env 有对应 Key）→ 发起一次读标 → 观测 `agent.model.error`/usage 记录的 provider 为 qwen；切回 deepseek 生效。配置留空/删除 → run 回退 env 默认，仍能跑。

## Self-Review 记录

- **覆盖**：配置存储（T1）、下发（T2）、agent 消费+覆盖（T3）、后台可配 UI（T4）、留档（T5）——需求全覆盖。
- **占位**：无 TBD；每个代码步给了完整代码或精确签名 + 断言。
- **类型一致**：`AgentModelSelection`（App）/`RunModelOverride`(agent)/`AgentModelForm`（admin）三处形状同构 `{provider, model, fallbacks}`，null↔"" 边界在 T4 显式处理；`model_override_to_settings` 映射到 Settings 三字段与 `config.py` 一致。
- **YAGNI**：不新增后端配置端点（复用 spec310 通用 `configs/:key`）；gateway 内部零改动（仅 Settings 覆盖）；Key 不入 DB。
