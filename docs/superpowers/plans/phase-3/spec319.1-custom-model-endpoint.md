# spec319.1 自建模型端点（OpenAI 兼容 base_url + api_key）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 逐任务执行。步骤用 `- [ ]`。

**Goal:** 让「模型管理」支持添加**自建 / 任意 OpenAI 兼容端点**的模型——填 `base_url` + `api_key` → 测连通并拉取 `/v1/models` 可用模型列表 → 下拉选一个或手填 → 纳入主模型/降级链，agent 运行时用该端点直连（不再限于内置注册表 deepseek/qwen/glm）。

**Architecture:** 现状 provider 固定 3 家（`base_url` 硬编码、key 从 env）。本 spec 让**单个模型条目自带 `baseUrl`/`apiKey`**：条目带 `baseUrl` ⇒ 自建端点，直接用它构造 ChatOpenAI；否则走注册表+env（不变，向后兼容）。run override 从「`provider:model` 字符串链」扩展为可携带 base_url/api_key 的**结构化链**。

**Tech Stack:** Agent = Python/FastAPI/langchain_openai；App = Hono+Bun+Drizzle+zod；Admin = Next.js+shadcn。

## Global Constraints

- 作者 `lookfree <etwuman@126.com>`；**禁止**任何 Claude 相关内容/Co-Authored-By。Conventional Commits 英文。
- 函数 ≤80 行、文件 ≤800 行、关键方法注释。
- **money-blind 铁律不变**：本功能不碰钱；agent 只按 usage 记账。
- **密钥策略（已定）**：`api_key` 明文存 `billing_configs`（agent 运行时要读）；**GET 返回给后台时打码**（`sk-****yA`），不回显明文；PUT 时条目未带新 key ⇒ 保留库里旧 key（按 id 合并）。
- **降级铁律**：自建端点不可达/测不通 ⇒ 该模型进不了链（沿用 chain 门槛 enabled+test.passed）；不影响其它模型与既有行为——注册表模型行为逐字节不变。
- 向后兼容：不带 `baseUrl` 的旧条目、旧 `agent_model` 结构、旧 run override（provider/model/fallbacks 字符串）全部照常工作。

---

### Task A: Agent — gateway/config 支持条目自带 base_url+api_key + 结构化链

**Files:**
- Modify: `services/agent/src/agent/config.py`（加 `model_chain` 字段）
- Modify: `services/agent/src/agent/models/gateway.py`（get_chat 接受 base_url/api_key；_chain 产出 dict；invoke 用之；override 映射 chain）
- Modify: `services/agent/src/agent/routes/runs.py`（`RunModelOverride` 加 `chain: list[dict] | None = None`——否则 pydantic `model_dump()` 丢掉 App 下发的 chain，自建端点运行时永远用不上；chapters.py 复用同一模型，自动带上）
- Test: `services/agent/tests/test_model_gateway.py`

**Interfaces:**
- Produces:
  - `Settings.model_chain: list[dict] | None = None`（仅 run override 注入，非 env）。每项 `{"provider": str, "model": str, "base_url": str | None, "api_key": str | None}`。
  - `ModelGateway.get_chat(provider=None, model=None, *, base_url=None, api_key=None, **kw)`：`base_url` 非空 ⇒ 直接 `ChatOpenAI(model=model, base_url=base_url, api_key=api_key or "sk-noauth", **params, **kw)`（**绕过** PROVIDERS/KEY_FIELD/env）；否则走原注册表路径（不变）。
  - `ModelGateway._chain(provider, model) -> list[dict]`：`settings.model_chain` 非空 ⇒ 原样返回它（每项含 provider/model/base_url/api_key）；否则由 provider/model/fallbacks 拼**旧行为**，每项补 `base_url=None, api_key=None`。
  - `model_override_to_settings(sel)`：`sel["chain"]` 是 list ⇒ 清洗后写 `out["model_chain"]`（每项 model 非空；有 base_url 则须 http/https，否则丢该项；空列表 ⇒ 不设）。原 provider/model/fallbacks/params 映射保留。

**实现要点:**
- `invoke()` 改为遍历 `self._chain(provider, model)` 的 dict：`chat = self.get_chat(it["provider"], it["model"], base_url=it["base_url"], api_key=it["api_key"])`；计时/记账/故障转移逻辑不变（记 usage 的 model 取 `getattr(chat,"model_name",it["model"])`，provider 取 `it["provider"]`）。
- `get_chat` 里 `**self._model_params()` 保持（temperature/max_tokens/top_p 仍全局生效于链上每个模型）。
- config.py：`model_chain` 放在现有 model_* 字段后，`list[dict] | None = None`；pydantic-settings 对 `| None` 复杂字段默认不从 env 解析——保持默认 None 即可（本字段只由 App override 经 `model_copy(update=...)` 注入）。

- [ ] **Step 1: 写失败测试** `test_model_gateway.py` 加：
  - `test_get_chat_custom_endpoint_uses_base_url`：`gw.get_chat("custom","qwen-x", base_url="http://h:8000/v1", api_key="sk-x")` 返回的 ChatOpenAI 的 `openai_api_base`/`model_name` 等于传入值（不查注册表、不要求 env key）。
  - `test_chain_from_model_chain_override`：settings 带 `model_chain=[{provider,model,base_url,api_key}, ...]` ⇒ `_chain()` 原样返回；无则回退旧的 provider/model/fallbacks 拼装且每项 base_url/api_key 为 None。
  - `test_override_maps_chain`：`model_override_to_settings({"chain":[{...合法...},{...model 空...},{...base_url 非法...}]})` ⇒ `model_chain` 只含合法项。
- [ ] **Step 2: 跑测试确认失败**：`uv run pytest tests/test_model_gateway.py -q`
- [ ] **Step 3: 实现** config.py + gateway.py 上述改动。
- [ ] **Step 4: 跑测试通过** + 回归：`uv run pytest tests/test_model_gateway.py tests/framework/ tests/test_model_usage.py -q`（invoke 路径改了，确保 forced_submit/agent_node 记账不回归）。
- [ ] **Step 5: 提交** `feat(agent): gateway supports per-model base_url/api_key + structured model_chain override`

---

### Task B: Agent — /models 列举可用模型 + 自建端点连通性探针

**Files:**
- Modify: `services/agent/src/agent/routes/models.py`
- Test: `services/agent/tests/test_models_route.py`

**Interfaces:**
- Produces:
  - `POST /models/list-models`，body `{base_url: str, api_key: str}` → httpx `GET {base_url}/models`（`Authorization: Bearer {api_key}`，超时 10s）→ `{"ok": true, "models": [id...]}`（取 `data[].id`，最多 100 条）。任何失败（超时/非 2xx/连接拒绝/解析错）→ `{"ok": false, "error": "<可读，≤200 字>"}`，**永不 500**。
  - `POST /models/test` 扩展：`TestBody` 加 `base_url: str | None = None`、`api_key: str | None = None`。`base_url` 非空 ⇒ `gw.get_chat("custom", body.model, base_url=..., api_key=...)`（不校验 PROVIDERS 白名单）；否则原注册表路径（`provider ∈ PROVIDERS` 校验保留）。其余 chat 探活/超时/token 统计逻辑不变。

- [ ] **Step 1: 写失败测试**（TestClient + monkeypatch httpx / gateway）：
  - list-models：mock httpx 返回 `{"data":[{"id":"qwen2.5-72b"},{"id":"qwen2.5-7b"}]}` ⇒ `{ok:true, models:[...]}`；mock 抛超时 ⇒ `{ok:false, error}` 且 HTTP 200。
  - test 自建：body 带 base_url ⇒ 调 `get_chat` 时 base_url/api_key 透传（用 fake gateway 断言入参），不因 provider 不在白名单而 400。
  - test 注册表回归：无 base_url、未知 provider ⇒ 仍 400（不回归）。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（httpx 用 `httpx.AsyncClient`，agent 已依赖）。
- [ ] **Step 4: 跑测试通过** `uv run pytest tests/test_models_route.py -q`
- [ ] **Step 5: 提交** `feat(agent): /models/list-models + custom base_url/api_key in /models/test`

---

### Task C: App API — 模型配置加 baseUrl/apiKey（校验+打码+合并）+ run override 结构化链 + 中转 list-models

**Files:**
- Modify: `apps/api/src/services/model-config.ts`（类型/schema/校验/规整/打码/合并）
- Modify: `apps/api/src/services/agent-client.ts`（`AgentModelSelection.chain`、`deriveRunOverride`、`testModel`、新增 `listModels`）
- Modify: `apps/api/src/routes/admin/models.ts`（GET 打码、PUT 合并密钥、POST /test 透传、POST /list-models 中转）
- Test: `apps/api/test/`（model-config 单测 + models 路由测试）

**Interfaces:**
- `ModelEntry` 加：`baseUrl?: string`、`apiKey?: string`。判别：`baseUrl` 非空 ⇒ 自建条目。
- `ModelEntrySchema`：`baseUrl: z.string().url().optional()`、`apiKey: z.string().optional()`；`provider: z.string().min(1)`（自建时 provider 是自由标签，去掉硬白名单——见校验）。
- `validateModelConfig`：
  - 自建条目（有 baseUrl）：`baseUrl` 须 http/https；`model` 非空；`apiKey` 非空（新建自建必须给 key）——但**合并后校验**（PUT 合并旧 key 之后再校验，见下）。**不**校验 provider 白名单。
  - 注册表条目（无 baseUrl）：`provider ∈ PROVIDERS`（原逻辑不变）。
  - params 范围、id 唯一、chain 门槛（enabled+test.passed）不变。
- 打码 `maskApiKey(k: string): string`：len>5 ⇒ `k.slice(0,3)+"****"+k.slice(-2)`，否则 `"****"`。
- `maskModelConfig(cfg): ModelConfig`（GET 用）：自建条目 `apiKey` 置为 `undefined`，加 `apiKeyHint = maskApiKey(stored)`（新增可选字段，仅出参展示）。注册表条目不动。
- `mergeModelSecrets(incoming, stored): ModelConfig`（PUT 用）：逐条 incoming，若自建且 `apiKey` 为空/缺省 ⇒ 从 stored 按 id 取旧 `apiKey` 填回；有非空 apiKey ⇒ 用新值。合并后再 `validateModelConfig`。
- `deriveRunOverride(cfg)`：新增 `chain: Array<{provider, model, base_url?, api_key?}>`（按 cfg.chain 顺序解析各条目；自建条目带 base_url/api_key）。仍保留 `provider/model/params`（primary，兼容/探针）；`fallbacks` 可继续给（字符串，自建条目跳过）——agent 端有 chain 优先，fallbacks 仅遗留兜底。
- `agent-client.listModels(opts: {baseUrl, apiKey})`：POST agent `/models/list-models`（body snake：`{base_url, api_key}`）→ `{ok, models?, error?}`。
- `agent-client.testModel`：入参加 `base_url?`、`api_key?`，snake 透传给 agent `/models/test`。
- routes/admin/models.ts：
  - `GET /` → `maskModelConfig(await getModelConfig())`。
  - `PUT /` → 解析（schema 含 baseUrl/apiKey）→ `mergeModelSecrets(parsed, await getModelConfig())` → `saveModelConfig`（内部 validate）。审计 `after` 用**打码后**的（勿把明文 key 写进 audit before/after）。
  - `POST /list-models`（`requirePermission("config.write")`）：body `{baseUrl, apiKey}` → `listModels` 中转 → 原样返回。
  - `POST /test`：TestBody 加 `base_url?`/`api_key?` 透传。

- [ ] **Step 1: 写失败测试**：
  - model-config：自建条目 validate（baseUrl 非法/model 空/apiKey 空 → 抛）；maskApiKey/maskModelConfig 打码；mergeModelSecrets 空 key 保留旧、非空覆盖；deriveRunOverride 产出 chain（自建带 base_url/api_key，注册表不带）；注册表路径全回归。
  - agent-client：listModels 打对 URL+snake body；testModel 带 base_url/api_key 透传。
  - 路由：GET 不回显明文 key（返回 apiKeyHint）；PUT 空 key 保留旧 key（先 PUT 建自建带 key，再 GET 拿打码，再 PUT 回去 key 空 → 库里 key 不变）；audit 不含明文；list-models 中转。
- [ ] **Step 2: 跑测试确认失败**（能本机 `bun test <file>` 的先跑）
- [ ] **Step 3: 实现**
- [ ] **Step 4: 类型 `bunx tsc --noEmit`（apps/api）通过；完整测试 mbp `./test-on-mbp.sh` 在 Task 收尾跑**
- [ ] **Step 5: 提交** `feat(api): custom model endpoint base_url/api_key — masked storage, secret merge, structured run chain, list-models relay`

---

### Task D: Admin UI — 添加/编辑自建模型（URL+key → 测连通 → 拉取模型下拉/手填）

**Files:**
- Modify: `apps/admin/lib/model-config.ts`（类型 + provider 放宽 + 标签）
- Modify: `apps/admin/lib/admin-api.ts`（listModels；test/save 带 base_url/api_key）
- Modify: `apps/admin/components/admin/models/model-card.tsx`（自建模式 UI）
- Modify: `apps/admin/components/admin/models/models-client.tsx`（handleAdd 支持自建草稿；probeModel 带 base_url/api_key）
- Test: `apps/admin`（lib 纯逻辑可 bun test；组件手动 e2e）

**Interfaces / UI:**
- `ModelEntry` 加 `baseUrl?: string`、`apiKey?: string`、`apiKeyHint?: string`（GET 回来的打码提示）。`Provider` 放宽为 `string`（自建 provider 为自由标签，默认 `"custom"`；`PROVIDER_LABELS` 对未知 key 回退显示 `baseUrl` 的 host 或「自建」）。`PROVIDER_OPTIONS` 增一项 `{ value: "custom", label: "自建 (OpenAI 兼容)" }`。
- `chainSummary`/`model-card` 展示名：自建条目用 `model @ <host>`；注册表沿用 `PROVIDER_LABELS[provider] model`。
- `admin-api.models`：
  - `listModels: (b:{baseUrl,apiKey}) => POST /models/list-models {baseUrl,apiKey}` → `{ok, models?, error?}`。
  - `test`：入参加 `baseUrl?`/`apiKey?`，body 里 snake 透传 `base_url`/`api_key`。
  - `save`：ModelConfig 里自建条目带 `baseUrl`/`apiKey`（apiKey 仅当用户新填；未改则不带，让服务端保留旧 key）。
- `model-card.tsx` 自建模式（provider==="custom" 或 baseUrl 存在）：
  - 显示 `base_url` 输入、`api_key` 输入（占位符用 `apiKeyHint`，留空表示不改）。
  - 「拉取可用模型」按钮 → `adminApi.models.listModels({baseUrl,apiKey})` → 成功把返回 models 填进一个 `<select>` 下拉（可选一个写入 `model`）；**同时保留手填输入**（下拉与手填并存，二选一）。
  - 「测试连通」→ probeModel 带 base_url/api_key（对选中的 model 做 chat 探活，成功才 test.passed→可入链）。
  - 注册表模式 UI 完全不变。
- `models-client.handleAdd`：新增模型时默认草稿仍是 deepseek 注册表（不破坏现状）；用户在卡片里把服务商切到「自建」即进入自建模式（切换时清空 model、重置 test）。`probeModel` 读取 model 的 baseUrl/apiKey 一并传给 `adminApi.models.test`。

- [ ] **Step 1: lib/model-config.ts + admin-api.ts 改类型/客户端**（纯逻辑加 bun test：PROVIDER_LABELS 回退、自建展示名）。
- [ ] **Step 2: model-card 自建模式 UI + 拉取下拉 + 手填并存**。
- [ ] **Step 3: models-client handleAdd/probeModel 接线**。
- [ ] **Step 4: `bunx tsc --noEmit`（apps/admin）通过；本地 `pnpm build` 或 admin lint 通过**。
- [ ] **Step 5: 提交** `feat(admin): add custom OpenAI-compatible model endpoint — url+key, fetch model list, manual/dropdown pick`

---

## 验证口径（全部任务完成后）

1. Agent：`uv run pytest -q`（mbp 或本机非 DB 子集）全绿。
2. App：`./test-on-mbp.sh` 全绿；`bunx tsc --noEmit` 通过。
3. Admin：`bunx tsc --noEmit` + build 通过。
4. e2e（部署 mbp 后，**需自建端点对 agent 容器可达**才能真正测通——网络由用户解决）：模型管理→添加→切「自建」→填 base_url+api_key→拉取可用模型→下拉选一个→测试连通→passed→加入主链→保存→跑一步生成走该端点。若端点不可达，UI 应给可读失败（不白屏、不 500），且不影响注册表模型。

## 决策记录

- **为何条目自带 base_url/api_key 而非「动态注册 provider」**：最小改动、单一真源；注册表路径逐字节不变；结构化链天然携带每跳端点。
- **为何密钥存库**：agent 运行时（另一进程/容器）要读；env 只适合固定 3 家。打码出参 + 按 id 合并回填，兼顾可用与不泄露。
- **ttft/网络**：自建端点可达性是部署网络问题（如 192.168.x LAN 对 agent 容器不可达），不在本 spec 代码范围；代码支持任意 base_url。
