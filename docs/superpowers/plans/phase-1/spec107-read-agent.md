# spec107 · 读标（第一个 agent_type） 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 写第一个真实智能体——**投标 `bidding_agent`**，本 spec 落地它的**第一个节点「读标」**（建在 spec105 框架上，create_agent 式，§4.2）：输入招标文件（MinIO key）→ `parse_document` 取全文 → 模型归类分析 → 用结构化 submit-tool 产出 **六大分类解读 + 废标风险 + 评分办法表**，结构与 C 端 `/read` 原型一致。`bidding_agent` 注册为**唯一一个 agent_type**，放进**自包含的 `agents/bidding_agent/` 包**；Phase 2 在同一个包里按节点扩出提纲/正文/审查/述标/导出，不重构骨架。

**Architecture:** `bidding_agent` 是**一条工作流 = 一个独立包**。Phase 1 工作流只有 `read` 一个节点：`agents/bidding_agent/nodes/read.py` 的 `build_read(ctx)` 给出 prompt + 工具 `[parse_document(spec106), submit_read_result(结构化)]`；`BiddingAgent(BaseAgent)`（`agent.py`）用它作单节点 create_agent 循环，复用框架 `astream`（spec105）流式跑、末尾把 submit 捕获的结构化结果作为 run 结果产出（spec104 executor 落 Redis/回传 App）。输出 schema 对齐前端 `analysisCategories`（六大分类 + item{title/value/原文摘录/status/risk/star}）。

**Tech Stack:** spec105 框架、spec106 parse_document、spec103 模型网关、Pydantic、pytest。

---

## 概念分层（贯穿 Phase 1-2，先讲清楚再写代码）

`bidding_agent` 这条投标流水线的三个层级，**不要混**：

| 层级 | 是什么 | 在 `bidding_agent` 里 |
|---|---|---|
| **agent_type** | 一个注册单元 = 一个独立包（目录）= 一个对外统一 run 契约 | 整条投标流水线 = **1 个**（`bidding_agent`），**只 `register("bidding_agent")` 一次** |
| **节点 node** | 工作流图里的一步，共享同一份 `BiddingState` + 同一 `thread_id` | read / outline / content / review / present / export = **6 个节点**（Phase 1 只落 read），步骤间用 `interrupt()` 串联，对应原型「逐页确认→下一步」 |
| **子agent subagent** | deepagent 在**节点内部**临场拆出的并行写作单元 | **只在 content（正文）节点**：主 agent 规划章节、子 agent 按章并行写、虚拟 FS 暂存草稿。读标/审查/述标等确定性节点**不拆子agent** |

**步骤如何驱动（决策已定，Phase 2 落地，此处锚定）**：**每"推进一步"是一个独立 `run_id`，整本标书共享一个 `thread_id`**。一本标书 = 一个 `thread_id`（靠 PostgresSaver checkpointer 续 `BiddingState`，§4.7）；读标一个 run、提纲一个 run……App `POST /agents/bidding_agent/runs {thread_id, input}` 跑到下一个 `interrupt()` 断点即结束本 run，下一步再发新 run、checkpointer 续状态接着跑下一节点。这样**按步计费/可观测最干净**（每步独立 run），又贴合原型逐页交互。Phase 1 只有 read 一个节点、暂无断点，所以此约定在 Phase 2 接 graph.py 时生效；Phase 1 已把包结构按它铺好（`state.py`/`nodes/`）。

---

## 前端交互对齐（依据 C 端原型 `/read`）

- 左栏「分类解读」**六大分类**：`overview 项目概况 / qualification 资格要求 / commercial 商务条款 / technical 技术需求 / scoring 评分办法 / format 格式与红线`。
- 每条 item：`title`、`value`、`status`（`found` 或文件未明确则 `missing`）、`risk`（废标风险，红标）、`star`（★不可偏离），并带**原文摘录**供右栏「招标文件原文」定位（原型用 clauseIds，Phase 1 先用 `source_quote` 文本摘录，精确条款锚定为加固项）。
- 评分办法表：`{category(技术方案/商务条款/投标报价), name, score, star, desc}`。
- 全流程：读标→提纲→生成→审查→述标（FlowNav）。本 spec 只做**读标**。

## Global Constraints

见 `spec100-index.md`。本 spec 关键约束：
- 建在框架上：用 `BaseAgent` + `make_submit_tool` + `parse_document`，不重复造运行时/SSE/观测。
- **一个 agent_type = 一个自包含包**：所有读标代码落在 `agents/bidding_agent/`；只注册 `bidding_agent` 一次；包结构按 Phase 2 全流程铺好，不返工。
- 输出结构对齐前端 `/read`（六大分类）；不碰钱、对业务无知（只认 file key + 文本）。
- 模型 Key 当前可能缺失 → 真实读标作可选冒烟；钩子/捕获用 fake 模型单测。
- 在 `main` 上先开分支；提交信息结尾附 Co-Authored-By。

---

## File Structure

```
services/agent/src/agent/agents/
├── __init__.py
└── bidding_agent/                         # ★ agent_type="bidding_agent" 自包含包(整条投标流水线;唯一注册单元)
    ├── __init__.py                  # 新：import agent → 触发 register("bidding_agent")
    ├── state.py                     # 新：BiddingState(贯穿全流程;Phase1 用 messages+file_key+read)
    ├── schemas.py                   # 新：ReadResult/ReadCategory/ReadItem/ScoringRow(Pydantic);Phase2 续加
    ├── prompts/
    │   ├── __init__.py
    │   └── read.py                  # 新：READ_SYSTEM_PROMPT
    ├── nodes/
    │   ├── __init__.py
    │   └── read.py                  # 新：build_read(ctx) 读标节点构造器(create_agent 式)
    └── agent.py                     # 新：BiddingAgent(BaseAgent) agent_type="bidding_agent"(Phase1 图=单 read 节点)
services/agent/tests/agents/bidding_agent/
├── test_read_schema.py              # 新：schema + submit-tool 捕获
└── test_read_agent.py               # 新：fake 模型驱动 → 捕获结构化结果 + 真实冒烟(skip)
```

> **Phase 2 在同一包内生长（不重构）**：加 `graph.py`（装配多节点 + 步骤间 `interrupt()`）、`nodes/{outline,content,review,present,export}.py`、`render/{docx,pptx}.py`，并把 `schemas.py`（加 Outline/RiskReport/DeckSpec）、`state.py`（加 outline/chapters/risk/deck）、`prompts/` 续写。`BiddingAgent` 届时切到「编译好的工作流图」驱动，对外 `astream`/run 契约不变。

---

## Interfaces（本 spec 对外产出，供 spec108 依赖）

- Produces：
  - `ReadResult`（Pydantic）：`project_meta`、`categories: list[ReadCategory]`、`scoring: list[ScoringRow]`、`risk_summary: list[str]`。
  - `BiddingState`（TypedDict）：贯穿全流程状态键（Phase 1 用 `messages`/`file_key`/`read`）。
  - `build_read(ctx) -> (prompt: str, tools: list, get_result: Callable[[], ReadResult|None])`：读标节点构造器（Phase 2 被 `graph.py` 当 read 节点装配）。
  - `agent_type="bidding_agent"` 注册（`BiddingAgent`）；run 契约（spec104）不变。
  - run 输入约定：`{ "text": "<含 file key 的指令>", "file_key": "<MinIO key>" }`（key 也写进 text，模型据此调用 `parse_document`）。
  - run 结果：`ReadResult.model_dump()`（spec104 落 Redis、回传 App；App 存 `project_artifacts`，前端 `/read` 渲染）。

---

## Task 1: 读标输出 schema + 工作流状态（schemas.py / state.py）

**Files:** Create `agents/__init__.py`、`agents/bidding_agent/__init__.py`（暂空，Task 2 填注册）、`agents/bidding_agent/schemas.py`、`agents/bidding_agent/state.py`、`tests/agents/bidding_agent/test_read_schema.py`

- [ ] **Step 1: 开分支 + 目录**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout -b phase1/spec107-read-agent
mkdir -p services/agent/src/agent/agents/bidding_agent/prompts \
         services/agent/src/agent/agents/bidding_agent/nodes \
         services/agent/tests/agents/bidding_agent
touch services/agent/src/agent/agents/__init__.py \
      services/agent/src/agent/agents/bidding_agent/__init__.py \
      services/agent/src/agent/agents/bidding_agent/prompts/__init__.py \
      services/agent/src/agent/agents/bidding_agent/nodes/__init__.py
```

- [ ] **Step 2: 写 `agents/bidding_agent/schemas.py`**

```python
from __future__ import annotations
from typing import Literal
from pydantic import BaseModel, Field

CategoryKey = Literal["overview", "qualification", "commercial", "technical", "scoring", "format"]


class ReadItem(BaseModel):
    title: str
    value: str
    source_quote: str = ""                        # 原文摘录，供前端定位
    status: Literal["found", "missing"] = "found"  # 文件未明确 -> missing
    risk: bool = False                             # 废标风险点
    star: bool = False                             # ★不可偏离


class ReadCategory(BaseModel):
    key: CategoryKey
    title: str
    items: list[ReadItem] = Field(default_factory=list)


class ScoringRow(BaseModel):
    category: str                                  # 技术方案/商务条款/投标报价
    name: str
    score: float
    star: bool = False
    desc: str = ""


class ReadResult(BaseModel):
    project_meta: dict = Field(default_factory=dict)        # name/code/buyer/budget/deadline...
    categories: list[ReadCategory]
    scoring: list[ScoringRow] = Field(default_factory=list)
    risk_summary: list[str] = Field(default_factory=list)   # 废标红线汇总
```

- [ ] **Step 3: 写 `agents/bidding_agent/state.py`**

```python
from __future__ import annotations
from typing import Annotated, Any, TypedDict
from langgraph.graph.message import add_messages


class BiddingState(TypedDict, total=False):
    """投标工作流贯穿状态：一本标书一个 thread_id，靠 checkpointer 续（§4.7）。
    Phase 1 只用到 messages / file_key / read；Phase 2 续加 outline / chapters / risk / deck。"""
    messages: Annotated[list, add_messages]
    file_key: str            # 招标文件 MinIO key
    read: dict[str, Any]      # ReadResult.model_dump()（read 节点产出）
    # —— Phase 2 增（占位，勿删注释，标明生长点）——
    # outline: dict[str, Any]   # Outline.model_dump()
    # chapters: dict[str, str]  # {chapter_id: body_html}
    # risk: dict[str, Any]      # RiskReport.model_dump()
    # deck: dict[str, Any]      # DeckSpec.model_dump()
```

- [ ] **Step 4: 失败测试 `tests/agents/bidding_agent/test_read_schema.py`**

```python
import asyncio
from agent.agents.bidding_agent.schemas import ReadResult
from agent.framework.structured import make_submit_tool


_SAMPLE = {
    "project_meta": {"name": "某市政务云运维", "code": "ZCY-2026-018", "budget": "￥1,680 万"},
    "categories": [
        {"key": "qualification", "title": "资格要求", "items": [
            {"title": "★信息安全认证", "value": "ISO27001（不可偏离）", "source_quote": "取得★ISO27001…",
             "status": "found", "risk": True, "star": True},
            {"title": "证明清单", "value": "未给出对照清单", "status": "missing"},
        ]},
    ],
    "scoring": [{"category": "技术方案", "name": "★运维服务体系", "score": 20, "star": True}],
    "risk_summary": ["ISO27001 不可偏离，缺失即废标"],
}


def test_read_result_validates():
    r = ReadResult(**_SAMPLE)
    assert r.categories[0].items[0].risk is True and r.categories[0].items[1].status == "missing"


def test_submit_read_tool_captures():
    tool, get = make_submit_tool("submit_read_result", ReadResult, "提交读标结果")
    asyncio.run(tool.ainvoke(_SAMPLE))
    assert isinstance(get(), ReadResult) and get().scoring[0].score == 20
```

- [ ] **Step 5: 通过 + 提交**

Run: `cd services/agent && uv run pytest tests/agents/bidding_agent/test_read_schema.py -q` → 2 passed
```bash
git add services/agent/src/agent/agents services/agent/tests/agents/bidding_agent/test_read_schema.py
git commit -m "feat(spec107): 读标输出 schema(六大分类) + BiddingState + submit-tool 捕获

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 读标节点 + BiddingAgent + 注册 + fake 模型端到端

**Files:** Create `agents/bidding_agent/prompts/read.py`、`agents/bidding_agent/nodes/read.py`、`agents/bidding_agent/agent.py`；Modify `agents/bidding_agent/__init__.py`；Create `tests/agents/bidding_agent/test_read_agent.py`

- [ ] **Step 1: 写 `agents/bidding_agent/prompts/read.py`**

```python
READ_SYSTEM_PROMPT = """你是资深投标读标专家。任务：通读招标文件，产出结构化解读，帮助投标人不漏关键点、不踩废标红线。

步骤：
1. 调用 parse_document(key) 读取招标文件全文（key 在用户消息中给出）。
2. 把信息归入六大分类：
   - overview 项目概况（项目/采购人/预算/关键时间…）
   - qualification 资格要求
   - commercial 商务条款（报价/保证金/付款/服务期…）
   - technical 技术需求
   - scoring 评分办法
   - format 格式与红线（编制/装订/废标条款…）
3. 每条给 title、value（提炼）、source_quote（原文摘录，便于定位）、
   status（招标文件明确=found；未明确/缺失=missing）、risk（是否废标风险点）、star（是否★不可偏离）。
4. 汇总 scoring（评分办法表）与 risk_summary（废标红线清单）。
5. 最后调用 submit_read_result 一次性提交完整结构化结果（务必字段完整、忠于原文、不臆造）。
"""
```

- [ ] **Step 2: 写 `agents/bidding_agent/nodes/read.py`（读标节点构造器）**

```python
from __future__ import annotations
from agent.framework.structured import make_submit_tool
from agent.parsing.tool import parse_document_tool
from agent.agents.bidding_agent.schemas import ReadResult
from agent.agents.bidding_agent.prompts.read import READ_SYSTEM_PROMPT


def build_read(ctx):
    """读标节点（create_agent 式）。返回 (prompt, tools, get_result)。
    get_result() 取 submit 捕获的 ReadResult（未提交则 None）。
    Phase 2：此函数作为 bidding_agent 工作流的 `read` 节点被 graph.py 装配（产出写入 BiddingState['read']）。"""
    submit, get_result = make_submit_tool("submit_read_result", ReadResult, "提交读标结构化结果")
    return READ_SYSTEM_PROMPT, [parse_document_tool, submit], get_result
```

- [ ] **Step 3: 写 `agents/bidding_agent/agent.py`**

```python
from __future__ import annotations
from typing import AsyncIterator
from agent.framework.base_agent import BaseAgent, AgentBuild
from agent.runtime.registry import RunContext
from agent.agents.bidding_agent.nodes.read import build_read


class BiddingAgent(BaseAgent):
    """投标智能体（agent_type="bidding_agent"，整条投标流水线唯一注册单元）。

    Phase 1：工作流只有 read 一个节点（create_agent 式单循环）。
    Phase 2：在 graph.py 装配 read→outline→content→review→present→export 多节点 + 步骤间 HITL 断点；
            本类切到「编译好的工作流图」驱动，对外 astream/run 契约不变。
    """
    agent_type = "bidding_agent"

    def build(self, ctx: RunContext) -> AgentBuild:
        prompt, tools, get_result = build_read(ctx)
        self._get_result = get_result
        return AgentBuild(prompt=prompt, tools=tools)

    async def astream(self, input: dict, ctx: RunContext) -> AsyncIterator[dict]:
        # 复用框架 astream 跑图流式；末尾把结构化结果作为 run 结果产出
        async for ev in super().astream(input, ctx):
            if ev.get("type") == "node.end":   # 跳过通用占位 result，最终以 submit 捕获为准
                continue
            yield ev
        result = self._get_result()
        if result is not None:
            yield {"type": "node.end", "node": "read", "data": {"result": result.model_dump()}}
```

- [ ] **Step 4: 写 `agents/bidding_agent/__init__.py`（触发注册）**

```python
from agent.agents.bidding_agent.agent import BiddingAgent  # noqa: F401 import 即 register("bidding_agent")

__all__ = ["BiddingAgent"]
```

- [ ] **Step 5: 写测试 `tests/agents/bidding_agent/test_read_agent.py`（fake 模型驱动 submit）**

```python
import asyncio
import os
import pytest
from langchain_core.messages import AIMessage
from agent.runtime.registry import get_agent, RunContext
from agent.telemetry.recorder import Recorder
from agent.db import pool
import agent.agents.bidding_agent  # noqa: F401 触发 register("bidding_agent")


_RESULT_ARGS = {
    "categories": [{"key": "qualification", "title": "资格要求",
                    "items": [{"title": "★ISO27001", "value": "不可偏离", "risk": True, "star": True}]}],
    "risk_summary": ["ISO27001 缺失即废标"],
}


class _ToolThenDoneChat:
    """第 1 次回 submit_read_result 的 tool_call，第 2 次回结束语。"""
    def __init__(self): self.n = 0
    def bind_tools(self, tools): return self
    async def ainvoke(self, messages):
        self.n += 1
        if self.n == 1:
            return AIMessage(content="", tool_calls=[{"name": "submit_read_result", "args": _RESULT_ARGS, "id": "c1"}])
        return AIMessage(content="读标完成")


class _GW:
    def get_chat(self, provider=None, model=None, **kw): return _ToolThenDoneChat()


def test_read_agent_captures_structured_result():
    agent = get_agent("bidding_agent")                      # BiddingAgent 已注册
    ctx = RunContext(run_id="r-read", agent_type="bidding_agent", thread_id="t-read",
                     recorder=Recorder(pool), gateway=_GW())

    async def run():
        return [ev async for ev in agent.astream({"text": "请读标，key=uploads/x/tender.pdf"}, ctx)]

    evs = asyncio.run(run())
    finals = [e for e in evs if e["type"] == "node.end" and e["node"] == "read"]
    assert finals, "应产出 read 结构化结果"
    res = finals[-1]["data"]["result"]
    assert res["categories"][0]["items"][0]["risk"] is True
    assert res["risk_summary"] == ["ISO27001 缺失即废标"]


@pytest.mark.skipif(not os.getenv("DEEPSEEK_API_KEY"), reason="需真实模型")
def test_read_agent_real_smoke():
    """可选：配了 Key + 上传过招标文件时，真实读标产出六大分类。"""
    ...
```

- [ ] **Step 6: 通过 + 提交**

Run: `cd services/agent && uv run pytest tests/agents/bidding_agent/test_read_agent.py -q` → 捕获测试通过（真实冒烟按 Key 跳过）
```bash
git add services/agent/src/agent/agents/bidding_agent tests/agents/bidding_agent/test_read_agent.py 2>/dev/null; \
git add services/agent/src/agent/agents/bidding_agent services/agent/tests/agents/bidding_agent/test_read_agent.py
git commit -m "feat(spec107): 读标节点 build_read + BiddingAgent(agent_type=bidding_agent) + fake 端到端

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 真实端到端冒烟 + 注册接入 worker + 合并

**Files:** Modify `src/agent/runtime/executor.py`（确保 import 注册 bidding_agent 包）

- [ ] **Step 1: 让 worker/executor 加载 bidding_agent 包（注册）**

在 `executor.py` 顶部（dummy 注册旁）加：

```python
import agent.agents.bidding_agent  # noqa: F401 注册 agent_type="bidding_agent"
```

- [ ] **Step 2: 真实端到端冒烟（需 DeepSeek Key + 已上传招标文件）**

```bash
# 前提：.env.bidsaas.local 配 DEEPSEEK_API_KEY；MinIO bidsaas 桶有一份 tender.pdf（key 记为 K）
cd services/agent && uv run python -m agent.migrate
# 终端1 worker / 终端2 api，然后：
curl -s -XPOST localhost:8090/agents/bidding_agent/runs -H 'content-type: application/json' \
  -d '{"input":{"text":"请对招标文件读标，key=K"}}'
curl -N localhost:8090/runs/<run_id>/stream     # 看流式进度
curl -s localhost:8090/runs/<run_id> | jq .result.categories  # 六大分类结构化结果
```
Expected: 产出六大分类 + 废标红线；`agent_token_usage` 记了 input/output/cached token（spec102）。
> 无 Key 时跳过；fake 测试已覆盖结构化链路。

- [ ] **Step 3: 全量 + lint + 合并**

Run: `cd services/agent && uv run pytest -q && uv run ruff check src`
Expected: 全 passed（真实冒烟 skip），ruff 无错。

```bash
git add services/agent/src/agent/runtime/executor.py
git commit -m "feat(spec107): worker 注册 bidding_agent 包 + 真实读标端到端"
git checkout main
git merge --no-ff phase1/spec107-read-agent -m "merge spec107: 读标(bidding_agent 第一个节点)"
git push origin main
```

---

## 与 Phase 2 全流程的衔接（此处只锚定，不实现）

读标产物（`ReadResult`）与后续节点产物走**同一框架套路**：模型用结构化 submit-tool 一次性产出 → 写入 `BiddingState` → 前端按 schema 渲染 →（需要时）渲染层出文件。Phase 2 在本包内按这张表扩节点（详见 Phase 2 计划）：

| 节点 | 页面 | 产出 schema（对齐原型） | 框架选型 |
|---|---|---|---|
| read（本 spec） | `/read` | `ReadResult`（六大分类 + scoring + risk_summary） | create_agent |
| outline | `/outline` | `Outline`（技术标/商务标章节 + 子项 + sourced/isNew） | create_agent |
| content | `/content` | 各章 `body`（HTML 正文） | **deepagent**（按章拆子agent） |
| review | `/risk` | `RiskReport`（score + 高/中风险 + 通过项 + 定位） | create_agent |
| present | `/present` | `DeckSpec`（Slide{kind/scoring/bullets/notes} + QA）→ `.pptx` | create_agent + 渲染层 |
| export | （导出） | 完整标书 `.docx` | 普通服务（渲染层） |

> 全流程统一「框架 + 结构化 submit-tool」，只是 schema 不同；步骤间 `interrupt()` + 每步独立 run（共享 thread_id）。**述标 PPT 渲染（python-pptx，§4.2.1）与完整标书导出（docx）归 Phase 2 的 render 层**。

---

## 验收清单（spec107 完成判据）

- [ ] `ReadResult` schema 对齐前端 `/read`：六大分类 + item{title/value/source_quote/status(found|missing)/risk/star} + scoring + risk_summary。
- [ ] `BiddingState` 定义贯穿全流程的状态键（Phase 1 用 messages/file_key/read，Phase 2 生长点已留注释）。
- [ ] `build_read(ctx)` 节点构造器可独立调用（返回 prompt/tools/get_result）。
- [ ] `submit_read_result` 强校验捕获；fake 模型驱动 → `astream` 末尾产出结构化 `ReadResult`。
- [ ] `BiddingAgent` 注册 `agent_type="bidding_agent"`（包 `__init__` import 即注册）；worker/executor 加载注册。
- [ ] run 输入 `{text(含 key)}` → 模型调 `parse_document` → 产出六大分类（真实冒烟，配 Key 时）。
- [ ] 包结构按 Phase 2 全流程铺好（`nodes/`、`prompts/`、`state.py`），Phase 2 扩节点不重构。
- [ ] `uv run pytest` + `ruff` 全绿（真实冒烟 skip）。
