---
name: agent-service-dev
description: 开发/迭代智能体服务（services/agent，Python 3.12 + FastAPI + LangGraph + deepagents）时使用——bidding_agent 投标工作流（读标→提纲→正文→审查→述标→导出）、框架层、新增智能体/节点/Pydantic schema。改 agent 逻辑/提示词/输出结构时读。
---

# 智能体服务开发（services/agent）

跑 LangGraph 工作流生成标书。**智能体对钱无感知——只上报 token 用量，绝不碰钱。**（扣费、鉴权全在 App API。）

## 技术栈与结构

- Python 3.12 + uv + FastAPI + LangGraph + deepagents。
- `src/agent/agents/bidding_agent/`：一个 LangGraph 工作流 = 一个自包含包。
  - `graph.py`（编排）、`state.py`、`schemas.py`（Pydantic 输出结构）。
  - `nodes/`：`read → outline → content → review → present → export`（六步流水线）；`deepagent` 只用于 `content` 节点。
  - `prompts/`（各节点提示词）、`render/`（`docx.py`/`pptx.py` 导出）。
- `src/agent/framework/`：`create_agent`/`base_agent`、`model_gateway`（模型网关）、`structured`（结构化输出）、`hitl`（human-in-the-loop）、`resilient`（韧性重试）、`compressor`（上下文压缩）、`hooks`。
- `app.py`/`main_api.py`（HTTP，`POST /agents/bidding_agent/runs` SSE）+ `main_worker.py`（双进程）；`checkpointer.py`（LangGraph PostgresSaver）、`config.py`、`db.py`、`migrate.py`、`models/`。

## 关键约定

1. **`agent_type` / 包名用直白 snake_case**——投标智能体 = `bidding_agent`（目录 `agents/bidding_agent/`、URL `/agents/bidding_agent/runs`）。新智能体各自一个包 + key（如 `contract_review`），走 `AgentRegistry` 按 `agent_type` 分发（一个进程）。
2. **只上报 usage**——节点结束上报 token 用量给 App API，由 App API 结算（`settle` 多退少补）。智能体不查/不改余额、不做鉴权。
3. **Pydantic 输出 schema 与前端字段对齐**——`bidding_agent/schemas.py` 的输出结构和前端 `apps/web/lib/sample-bid.ts`/`present.ts` 的 TS 类型**逐字段对齐**（读标/提纲/正文/审查/述标 PPT）。注意 **snake_case（Python）↔ camelCase（前端 TS）** 由 App 层 `toCamel` 桥接。
4. **数据分 schema**——同一 PostgreSQL 库 `bidsaas` 三 schema：`public`（App 业务+账本，Drizzle）/ `langgraph`（PostgresSaver 检查点）/ `agent`（观测）。智能体只写 `langgraph`+`agent`。
5. **强制结构化输出/工具**——用 `framework/structured` 的 forced tool_choice；产物走 artifacts 契约（Phase 2 spec201-207）。
6. **设计文档口径**——文档里不出现外部框架名/「借鉴/inspired-by」字样，一切当自研设计表述。

## 命令与测试

```bash
cd services/agent
uv run pytest                         # 全量
uv run pytest tests/path::test_name -q  # 单测
```

（注意：本机跑需要能连库/模型；观测与检查点表在 `langgraph`/`agent` schema。）

## 迭代节奏

改节点/提示词/schema → 加/改 `tests/` → `uv run pytest` 绿。新增智能体：复制 `bidding_agent` 结构、注册进 AgentRegistry、Pydantic schema 与消费方对齐。提交规范同仓库。
