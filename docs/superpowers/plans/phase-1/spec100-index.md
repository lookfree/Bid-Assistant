# Phase 1 · 智能体跑通（核心价值验证）—— 实现计划索引（spec100）

> 把架构方案 §8 的 **Phase 1** 细化为 spec101–spec106，每个是可独立执行、独立测试的实现计划。
> 上游基线：`docs/superpowers/specs/2026-06-24-bid-assistant-saas-architecture.md`（§4 智能体服务详设、§4.6 API/Worker 拆分、§4.7 Checkpointer、§3.2 边界铁律、§7 数据流）。
> **Phase 1 产出目标**：上传招标文件 →（App 预扣 stub → 调智能体服务 → AI「读标」→ SSE 流式回传 → settle stub）端到端打通。**★最关键里程碑。**

## spec 清单与依赖顺序

> **框架优先**：本服务做成**可复用的智能体框架**，投标=框架上的**第一个 `agent_type`**；后续"合同审查/方案撰写"等只写一个 `BaseAgent` 子类 + 注册，复用全部框架层。框架同时支持两类节点：**create_agent 式**（确定性，如读标/审查）与 **deepagent 式**（动态规划 + 子智能体 + 虚拟 FS，如正文生成）。

| spec | 主题 | 交付物（可测） | 依赖 |
|---|---|---|---|
| **spec101** | Agent Service 骨架 | `services/agent` Python(uv)+FastAPI；`/healthz`/`/readyz`；env(Pydantic)；api/worker 双角色脚手架；连 bidsaas | Phase 0 中间件 |
| **spec102** | 观测与埋点（横切，§4.4） | **`agent` schema** 四表，**每表带 `agent_type`**，token 记 input/output/cached/reasoning + ttft/latency；`Recorder` 埋点器 | spec101 |
| **spec103** | 模型网关 Model Gateway | DeepSeek/通义/智谱 OpenAI 兼容、切换 + 故障转移；每次调用经 `Recorder.record_usage` | spec101、102 |
| **spec104** | Run 运行时 + 注册 + 契约 | `AGENT_REGISTRY`、`/agents/{type}/runs`、`/runs/{id}`(+SSE)；队列派发 + Worker（§4.6）；**PostgresSaver checkpointer**（§4.7）；事件埋点；usage 回调；dummy 端到端 | spec101、102 |
| **spec105** | **智能体编写框架** | `BaseAgent` 基类 + **Hook/中间件管线**（上下文注入/输出契约/丢畸形 tool call/工具强制）+ **可插拔 Backend 协议**（in-state/DB/MinIO + `create_backend_tools`）+ **健壮性层**（resilient tool node/幻觉守卫）+ **上下文压缩节点** + **结构化输出 submit-tool** + **`hitl.py` 人机交互** + **deepagent 式节点支持**（动态规划/子智能体/虚拟 FS，配正文生成） | spec103、104 |
| **spec106** | 文档解析 | docx/pdf/xlsx → 纯文本/结构（横切，§4.4） | spec101 |
| **spec107** | 读标 = 第一个 agent_type | **建在 spec105 框架上**的 `BaseAgent` 子类：招标文件 → 六大分类解读 + 废标风险点；SSE 流式；埋点 | spec105、106、103 |
| **spec108** | App 编排接入（★里程碑） | App API：`agent_runs` 表 + 编排（预扣 stub → 建 run → 调 agent → SSE 中继）+ settle stub（消费 `agent_token_usage` 汇总）+ 接 C 端 `/read` | spec104、107、Phase 0 App API |

> 关键路径：101→102→(103/104) →**105 框架**→(106 并行)→**107 第一个智能体**→108 里程碑。
> **框架层 = 101–105**（与具体智能体无关，可复用）；**第一个智能体 = 107**（投标读标，建在框架上）。

---

## Global Constraints（全局约束 · 每个 spec 隐含包含）

**语言与运行时（智能体服务）**
- **Python 3.12+**，包管理 **uv**；Web 框架 **FastAPI**（ASGI，uvicorn）。
- 编排 **LangGraph**（骨架）+ **deepagents**（仅开放式节点，读标用 `create_agent` 不用 deepagent，§4.2）；锁定 deepagents 版本（§4.7 注意子 agent checkpoint #573）。
- 测试 **pytest**（+ `pytest-asyncio`）。

**模型（经 Model Gateway）**
- DeepSeek / 通义千问(Qwen) / 智谱(GLM)，均走 **OpenAI 兼容端点**（langchain `ChatOpenAI` + 自定义 `base_url`）；按配置切换 + 故障转移。
- 模型 Key 只从 env 读（`.env`，不入库）；**不碰钱**，只上报 token/usage（§3.2 铁律①）。

**数据与中间件（复用 Phase 0 的裸机实例，§14）**
- **bidsaas 库三 schema 布局（职责分离）**：
  - `public` —— App 业务 + 账本（drizzle，Phase 0/3），含 `agent_runs` 业务桥接表。
  - `langgraph` —— **框架自建**：`PostgresSaver.setup()` 创建 `checkpoints`/`checkpoint_blobs`/`checkpoint_writes`/`checkpoint_migrations` 四表（spec104 当迁移跑一次；连接设 `search_path=langgraph,public` 使其落该 schema）。
  - `agent` —— **智能体服务自建**：观测埋点表（spec102），见下。
- **观测埋点表（`agent` schema，spec102）**：
  - `agent_request`（每 run 一行：状态/起止/耗时/`thread_id`(会话键)/文件引用）
  - `agent_event_log`（追加式事件时间线：`event_type`/`seq`(run 内递增)/`node`/`level`/`data`/`event_meta`/`thread_id`）
  - ID 口径：只用 `run_id`(一次执行) + `thread_id`(会话,LangGraph 原生)；**不用 `conversation_id`/`request_id`**（追踪需求将来加 `trace_id`）
  - `agent_token_usage`（每次模型调用，记 **input/output/cached/reasoning/total** token + `ttft_ms`/`latency_ms`(LLM 耗时)）
  - 可选 `agent_tool_call`
  - **每张表都带 `agent_type`** 便于按类型聚合；输入/事件 payload 默认脱敏。
- 队列 + pub/sub：**bidsaas Redis**，前缀 `bid:agent:`（派发用 Redis Stream，进度回传用 pub/sub，§4.6）。
- 文件：从 **MinIO**（bidsaas 桶）按 key 读招标文件（App 传文件引用，不传二进制）。
- **归属边界**：`agent.*` 与 `langgraph.*` 是智能体侧执行/观测数据，与 App 的 `public.agent_runs`（业务/积分）靠 `run_id` 关联但分开存（§4.7）。

**边界铁律（§3.2，贯穿全程）**
- 钱只有一个权威 = App API；**智能体服务对业务无知**（只认 `input + agent_type + 文件引用`，不知道"项目/会员/积分"）；长任务**异步 + SSE**。
- 执行后端默认 **FilesystemBackend（虚拟 FS）+ 自定义工具，不开 `execute`**（§4.5）；OpenSandbox 仅未来需跑不可信代码时启用。

**工程纪律**
- TDD；服务对外统一 run 契约（§4.3），App 经内部 REST 调用 + usage 回调。
- 频繁提交；提交信息结尾附 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`；在 `main` 上先开分支再改。

---

## 执行方式

每个 spec 用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实现。spec 内步骤用 `- [ ]` 复选框跟踪。
