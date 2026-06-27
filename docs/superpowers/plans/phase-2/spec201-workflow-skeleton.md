# spec201 · 投标工作流编排骨架 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `bidding_agent` 从「只有 read 一个节点」长成一条**可暂停/恢复的多节点工作流图**：`agents/bidding_agent/graph.py` 的 `build_bidding_workflow()` 用 LangGraph `StateGraph` 把 `read→outline→content→review→present→export` 接起来，**步骤间 `interrupt()` 断点**；`BiddingAgent` 切到「编译图驱动」；落地**每步一个 run + 共享 thread_id** 的运行契约（一个 run 跑到下一个断点即止）。本 spec 只有 read 是真实节点，其余先放 **stub**（写占位入 state 即暂停），保证整图可从头跑到尾、可逐节点恢复。

**Architecture:** `BaseAgent` 加一个**可选钩子 `build_graph(ctx)`**：返回 `CompiledStateGraph` 则 `astream` 驱动它，否则退回 Phase 1 的单 create_agent 循环（`build()`）。`BiddingAgent.build_graph` 返回 `build_bidding_workflow(ctx)`——一张带 checkpointer + `interrupt_after=<每个节点>` 的图。`astream` 按 thread_id 检测 checkpoint：无则用 `input` 播种从 read 起，有则以 `None` 续跑；每次只推进到下一个断点，把该节点产出作为 run 结果产出。

> **read 输入口径**：read 节点统一用 `state['file_key']`（由 run input 的 `file_key` 播种），不再依赖 `text`。
> **替换旧 astream**：spec107 的旧 `BiddingAgent.astream`（单循环产 `node.end`）**被本 spec 的编译图驱动 astream 完全替换**——实现时直接覆盖旧方法，不要保留旧 astream，否则会双产出。

**Tech Stack:** LangGraph（StateGraph/interrupt/PostgresSaver）、spec104 RunContext/checkpointer、spec105 BaseAgent、Pydantic、pytest。

## Global Constraints

见 `spec200-index.md`。本 spec 关键约束：
- 一个包内生长：只动 `agents/bidding_agent/`（+ 一处 `base_agent.py` 加钩子）；`bidding_agent` 仍是唯一 agent_type。
- 步骤间 `interrupt()`；**每步一个 run、共享 thread_id**；run 跑到下一个断点即结束。
- 非 read 节点本 spec 用 stub；后续 spec202–206 逐个替换为真实节点，**不动 graph 连边逻辑**。
- TDD；`main` 上先开分支；提交信息附 Co-Authored-By。

---

## File Structure

```
services/agent/src/agent/
├── framework/base_agent.py          # 改：加可选钩子 build_graph(ctx)→CompiledStateGraph|None
└── agents/bidding_agent/
    ├── state.py                     # 改：BiddingState 扩全字段（outline/chapters/risk/deck/artifacts/step）
    ├── graph.py                     # 新：build_bidding_workflow(ctx) StateGraph + interrupt_after
    ├── agent.py                     # 改：BiddingAgent.build_graph + astream 改为编译图驱动
    └── nodes/
        ├── read.py                  # 改：导出 read_node(ctx) 适配 graph 节点签名（state→state）
        ├── outline.py               # 新：stub 节点（写占位 outline 入 state）
        ├── content.py               # 新：stub
        ├── review.py                # 新：stub
        ├── present.py               # 新：stub
        └── export.py                # 新：stub
services/agent/tests/agents/bidding_agent/
├── test_graph_build.py             # 新：图能编译、节点/断点齐全
└── test_graph_stepwise.py          # 新：fake 模型 → 每步一个 run、thread_id 续到下一节点
```

---

## Interfaces（本 spec 对外产出）

- Produces：
  - `build_bidding_workflow(ctx) -> CompiledStateGraph`：编译好的投标工作流图（含 checkpointer + 节点间断点）。
  - `BaseAgent.build_graph(ctx) -> CompiledStateGraph | None`：基类可选钩子（默认 `None`）。
  - 节点构造器统一签名 `*_node(state: BiddingState) -> dict`（返回要并入 state 的增量）；spec202–206 各自实现。
  - run 契约扩展：run 输入 `{ "file_key": "...", "step": "<目标节点，可选>" }`；同 `thread_id` 反复发 run 即逐步推进。

---

## Task 1: BiddingState 扩字段 + BaseAgent.build_graph 钩子

**Files:** Modify `agents/bidding_agent/state.py`、`framework/base_agent.py`；Create `tests/agents/bidding_agent/test_graph_build.py`（先建空壳，Task 2 填断言）

- [ ] **Step 1: 开分支**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout -b phase2/spec201-workflow-skeleton
```

- [ ] **Step 2: 改 `agents/bidding_agent/state.py`（放开 Phase 2 字段）**

```python
from __future__ import annotations
from typing import Annotated, Any, TypedDict
from langgraph.graph.message import add_messages


def _merge_dict(a: dict | None, b: dict | None) -> dict:
    return {**(a or {}), **(b or {})}


class BiddingState(TypedDict, total=False):
    """投标工作流贯穿状态：一本标书一个 thread_id，靠 checkpointer 续（§4.7）。"""
    messages: Annotated[list, add_messages]
    file_key: str                  # 招标文件 MinIO key
    read: dict[str, Any]           # ReadResult.model_dump()      ← read（spec107）
    outline: dict[str, Any]        # Outline.model_dump()         ← outline（spec202）
    chapters: dict[str, str]       # {chapter_id: body_html}      ← content（spec203）
    risk: dict[str, Any]           # RiskReport.model_dump()      ← review（spec204）
    deck: dict[str, Any]           # DeckSpec.model_dump()        ← present（spec205）
    artifacts: Annotated[dict[str, str], _merge_dict]  # {"docx": key, "pptx": key} ← export/present（spec205/206）；合并 reducer 让二者并存
    step: str                      # 当前/目标节点（App 按步驱动）
```

> `artifacts` 用合并 reducer（`_merge_dict`）：present 写 `{"pptx": key}`、export 写 `{"docx": key}`，默认 last-write-wins 会互相覆盖；reducer 让二者并存。此 reducer **只在本 state.py 定义一次**，下游 spec205/206 直接依赖、不再重复定义。

- [ ] **Step 3: 改 `framework/base_agent.py`（加可选钩子）**

在 `BaseAgent` 加一个默认返回 `None` 的方法，并在 `_compile()` 里优先用它：

```python
class BaseAgent:
    # ... 既有 agent_type / build() / astream() ...

    def build_graph(self, ctx):
        """可选：子类返回已编译的 CompiledStateGraph（多节点工作流）则用之；
        默认 None → 退回 build() 的单 create_agent 循环（Phase 1 行为）。"""
        return None

    def _compile(self, ctx):
        graph = self.build_graph(ctx)
        if graph is not None:
            return graph
        return self._compile_single_loop(ctx)   # 既有：用 build() 的 prompt+tools 编单循环
```

> 兼容性：Phase 1 的 read 不覆盖 `build_graph` → 行为不变；本 spec 让 `BiddingAgent` 覆盖它（Task 3）。

- [ ] **Step 4: 写测试空壳 + 跑全量绿**

`tests/agents/bidding_agent/test_graph_build.py`：
```python
def test_placeholder():
    assert True
```
Run: `cd services/agent && uv run pytest tests/agents/bidding_agent/ -q` → 全 passed（含 spec107 既有）。

- [ ] **Step 5: 提交**

```bash
git add services/agent/src/agent/agents/bidding_agent/state.py services/agent/src/agent/framework/base_agent.py services/agent/tests/agents/bidding_agent/test_graph_build.py
git commit -m "feat(spec201): BiddingState 扩全字段 + BaseAgent.build_graph 钩子

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 节点统一签名（read 适配 + 其余 stub）+ graph.py

**Files:** Modify `agents/bidding_agent/nodes/read.py`；Create `nodes/{outline,content,review,present,export}.py`、`agents/bidding_agent/graph.py`；Modify `tests/agents/bidding_agent/test_graph_build.py`

- [ ] **Step 1: 改 `nodes/read.py`——导出 graph 节点 `read_node`**

保留 `build_read(ctx)`（Phase 1 单循环仍可用）；新增图节点封装：在节点内跑读标子 agent、把 `ReadResult` 写入 `state['read']`。

```python
from __future__ import annotations
from agent.framework.structured import make_submit_tool
from agent.framework.create_agent import build_create_agent   # spec105 提供：prompt+tools→可跑的子图
from agent.parsing.tool import parse_document_tool
from agent.agents.bidding_agent.schemas import ReadResult
from agent.agents.bidding_agent.prompts.read import READ_SYSTEM_PROMPT


def build_read(ctx):
    submit, get_result = make_submit_tool("submit_read_result", ReadResult, "提交读标结构化结果")
    return READ_SYSTEM_PROMPT, [parse_document_tool, submit], get_result


def make_read_node(ctx):
    """graph 节点：读招标文件→产 ReadResult→写入 state['read']。"""
    async def read_node(state):
        prompt, tools, get_result = build_read(ctx)
        sub = build_create_agent(prompt, tools, ctx)            # 一个 create_agent 子图
        text = f"请对招标文件读标，key={state['file_key']}"
        await sub.ainvoke({"messages": [{"role": "user", "content": text}]})
        result = get_result()
        return {"read": result.model_dump() if result else {}}
    return read_node
```

> `build_create_agent` 来自 spec105 框架层（把 prompt+tools 编成可 `ainvoke` 的子图）。若 spec105 暴露名不同，按实际导出名调整（Interfaces 已声明本 spec 依赖它）。

- [ ] **Step 2: 写 5 个 stub 节点 `nodes/{outline,content,review,present,export}.py`**

每个形如（以 outline 为例，其余同构，写各自占位键）：

```python
# nodes/outline.py
def make_outline_node(ctx):
    async def outline_node(state):
        # spec202 替换为真实 create_agent + submit_outline
        return {"outline": {"_stub": True, "chapters": []}}
    return outline_node
```

对应占位键：`content_node→{"chapters": {"_stub": ""}}`、`review_node→{"risk": {"_stub": True}}`、`present_node→{"deck": {"_stub": True}}`、`export_node→{"artifacts": {"docx": "_stub"}}`。

- [ ] **Step 3: 写 `agents/bidding_agent/graph.py`**

```python
from __future__ import annotations
from langgraph.graph import StateGraph, START, END
from agent.agents.bidding_agent.state import BiddingState
from agent.agents.bidding_agent.nodes.read import make_read_node
from agent.agents.bidding_agent.nodes.outline import make_outline_node
from agent.agents.bidding_agent.nodes.content import make_content_node
from agent.agents.bidding_agent.nodes.review import make_review_node
from agent.agents.bidding_agent.nodes.present import make_present_node
from agent.agents.bidding_agent.nodes.export import make_export_node

NODE_ORDER = ["read", "outline", "content", "review", "present", "export"]


def build_bidding_workflow(ctx):
    """投标工作流：6 节点顺序串联，每个节点后 interrupt（每步一个 run）。
    checkpointer 来自 ctx（PostgresSaver，§4.7），保证同 thread_id 续 BiddingState。"""
    g = StateGraph(BiddingState)
    g.add_node("read", make_read_node(ctx))
    g.add_node("outline", make_outline_node(ctx))
    g.add_node("content", make_content_node(ctx))
    g.add_node("review", make_review_node(ctx))
    g.add_node("present", make_present_node(ctx))
    g.add_node("export", make_export_node(ctx))
    g.add_edge(START, "read")
    for a, b in zip(NODE_ORDER, NODE_ORDER[1:]):
        g.add_edge(a, b)
    g.add_edge("export", END)
    # 每个节点产出后暂停 → App 在对应原型页确认后发新 run 续跑
    return g.compile(checkpointer=ctx.checkpointer, interrupt_after=NODE_ORDER)
```

- [ ] **Step 4: 填 `test_graph_build.py`**

```python
from agent.agents.bidding_agent.graph import build_bidding_workflow, NODE_ORDER


class _FakeCtx:
    checkpointer = None      # compile 允许 None（测试只验证结构）
    gateway = None
    def __getattr__(self, k): return None


def test_workflow_compiles_with_all_nodes():
    g = build_bidding_workflow(_FakeCtx())
    nodes = set(g.get_graph().nodes)
    for n in NODE_ORDER:
        assert n in nodes, f"缺节点 {n}"


def test_node_order_is_full_bidding_flow():
    assert NODE_ORDER == ["read", "outline", "content", "review", "present", "export"]
```

Run: `cd services/agent && uv run pytest tests/agents/bidding_agent/test_graph_build.py -q` → 2 passed
> 若 `compile(checkpointer=None, interrupt_after=...)` 在当前 LangGraph 版本报错，测试改用 `MemorySaver()`（`from langgraph.checkpoint.memory import MemorySaver`）。

- [ ] **Step 5: 提交**

```bash
git add services/agent/src/agent/agents/bidding_agent/nodes services/agent/src/agent/agents/bidding_agent/graph.py services/agent/tests/agents/bidding_agent/test_graph_build.py
git commit -m "feat(spec201): bidding_agent 6 节点工作流图 + 步骤间 interrupt(read 真实, 其余 stub)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: BiddingAgent 切到编译图驱动 + 每步 run/resume

**Files:** Modify `agents/bidding_agent/agent.py`；Create `tests/agents/bidding_agent/test_graph_stepwise.py`

- [ ] **Step 1: 改 `agents/bidding_agent/agent.py`**

```python
from __future__ import annotations
from typing import AsyncIterator
from agent.framework.base_agent import BaseAgent
from agent.runtime.registry import RunContext
from agent.agents.bidding_agent.graph import build_bidding_workflow, NODE_ORDER


class BiddingAgent(BaseAgent):
    """投标智能体（agent_type="bidding_agent"）：一条多节点工作流，步骤间 interrupt。
    每个 run 推进到下一个断点即止；同 thread_id 反复发 run 逐步走完全流程。"""
    agent_type = "bidding_agent"

    def build_graph(self, ctx: RunContext):
        return build_bidding_workflow(ctx)

    async def astream(self, input: dict, ctx: RunContext) -> AsyncIterator[dict]:
        graph = self._compile(ctx)
        config = {"configurable": {"thread_id": ctx.thread_id}}
        # 判定：该 thread 是否已有 checkpoint（已起过 → 续跑；否则用 input 播种）
        snap = await graph.aget_state(config)
        if snap.values:                              # 已有状态 → 续跑下一节点
            payload = None
        else:                                        # 新标书 → 从 read 起（read 节点用 state['file_key']）
            payload = {"file_key": input.get("file_key", ""),
                       "messages": []}
        async for ev in graph.astream(payload, config=config, stream_mode="updates"):
            for node, delta in ev.items():
                yield {"type": "node.end", "node": node, "data": {"delta": delta}}
        # 本 run 停在某个 interrupt：产出"刚完成节点"的结果给 App
        snap2 = await graph.aget_state(config)
        done = _last_done_node(snap2)
        if done:
            # 带 artifacts 快照：present 步的 _RESULT_KEY 是 deck（不含 artifacts），
            # 否则 App 永远拿不到 pptx/docx key。
            yield {"type": "step.done", "node": done,
                   "data": {"result": snap2.values.get(_RESULT_KEY[done]),
                            "artifacts": snap2.values.get("artifacts", {})}}


_RESULT_KEY = {"read": "read", "outline": "outline", "content": "chapters",
               "review": "risk", "present": "deck", "export": "artifacts"}


def _last_done_node(snap):
    """已写入结果的最后一个节点（按 NODE_ORDER）。"""
    last = None
    for n in NODE_ORDER:
        if snap.values.get(_RESULT_KEY[n]):
            last = n
    return last
```

> 关键：`stream_mode="updates"` 让每个节点产出即流式回传（SSE 进度）；`interrupt_after` 使一次 `astream` 只推进到下一个断点。App 拿 `step.done` 的 `result` 渲染对应页，确认后再发下一个 run。

- [ ] **Step 2: 写 `tests/agents/bidding_agent/test_graph_stepwise.py`（每步一个 run、thread 续）**

```python
import asyncio
import pytest
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import MemorySaver
from agent.runtime.registry import get_agent, RunContext
import agent.agents.bidding_agent  # noqa: F401 注册


class _ReadSubmitChat:
    def __init__(self): self.n = 0
    def bind_tools(self, tools): return self
    async def ainvoke(self, messages):
        self.n += 1
        if self.n == 1:
            return AIMessage(content="", tool_calls=[{"name": "submit_read_result",
                "args": {"categories": [{"key": "qualification", "title": "资格", "items":
                [{"title": "★ISO27001", "value": "不可偏离", "risk": True, "star": True}]}],
                "risk_summary": ["缺 ISO27001 即废标"]}, "id": "c1"}])
        return AIMessage(content="done")


class _GW:
    def get_chat(self, **kw): return _ReadSubmitChat()


def _ctx():
    return RunContext(run_id="r1", agent_type="bidding_agent", thread_id="proj-1",
                      gateway=_GW(), checkpointer=MemorySaver())


def test_run1_produces_read_then_stops():
    agent = get_agent("bidding_agent")
    ctx = _ctx()

    async def run():
        return [e async for e in agent.astream({"file_key": "uploads/x/tender.pdf"}, ctx)]

    evs = asyncio.run(run())
    done = [e for e in evs if e["type"] == "step.done"][-1]
    assert done["node"] == "read"
    assert done["data"]["result"]["risk_summary"] == ["缺 ISO27001 即废标"]


def test_run2_resumes_to_outline_stub():
    """同 thread_id 第二个 run：checkpointer 续状态，推进到 outline（stub）。"""
    agent = get_agent("bidding_agent")
    cp = MemorySaver()
    ctx1 = RunContext(run_id="r1", agent_type="bidding_agent", thread_id="proj-2", gateway=_GW(), checkpointer=cp)
    ctx2 = RunContext(run_id="r2", agent_type="bidding_agent", thread_id="proj-2", gateway=_GW(), checkpointer=cp)

    async def go():
        async for _ in agent.astream({"file_key": "k"}, ctx1):
            pass                                  # run1 → read，停在断点
        return [e async for e in agent.astream({}, ctx2)]   # run2 → 续到 outline

    evs = asyncio.run(go())
    nodes = [e["node"] for e in evs if e["type"] == "step.done"]
    assert "outline" in nodes                     # 续跑推进到了下一节点
```

Run: `cd services/agent && uv run pytest tests/agents/bidding_agent/test_graph_stepwise.py -q` → 2 passed

- [ ] **Step 3: 提交**

```bash
git add services/agent/src/agent/agents/bidding_agent/agent.py services/agent/tests/agents/bidding_agent/test_graph_stepwise.py
git commit -m "feat(spec201): BiddingAgent 编译图驱动 + 每步一个 run(共享 thread_id 续)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 真实 checkpointer 走查 + 合并

**Files:**（无新增；验证 PostgresSaver 路径）

- [ ] **Step 1: 真实 checkpointer 冒烟（PG langgraph schema）**

```bash
# 前提：spec104 已 PostgresSaver.setup()（langgraph schema 四表在）
cd services/agent && uv run pytest tests/agents/bidding_agent/ -q
```
Expected: 全 passed。手测（配 Key）：同一 `thread_id` 发两次 `/agents/bidding_agent/runs`，第二次从 checkpoint 续到 outline（stub）。

- [ ] **Step 2: 全量 + lint + 合并**

Run: `cd services/agent && uv run pytest -q && uv run ruff check src`
```bash
git checkout main
git merge --no-ff phase2/spec201-workflow-skeleton -m "merge spec201: 投标工作流编排骨架(多节点+断点+每步run)"
git push origin main
```

---

## 验收清单（spec201 完成判据）

- [ ] `BiddingState` 含全流程字段（read/outline/chapters/risk/deck/artifacts/step）；`artifacts` 带合并 reducer（`_merge_dict`，**只在本 state.py 定义一次**），pptx/docx 并存不互相覆盖。
- [ ] `BaseAgent.build_graph(ctx)` 钩子加好；不覆盖时 Phase 1 单循环行为不变。
- [ ] `build_bidding_workflow(ctx)` 编出 6 节点图 + 步骤间 `interrupt_after`；read 真实、其余 stub；read 节点用 `state['file_key']`。
- [ ] `BiddingAgent` 用编译图驱动（完全替换 spec107 旧单循环 astream，无双产出）；**一个 run 推进到下一个断点即止**，产出 `step.done{node,result,artifacts}`（带 artifacts 快照）。
- [ ] 同 `thread_id` 第二个 run 经 checkpointer 续状态、推进到下一节点（fake 测试覆盖）。
- [ ] 真实 PostgresSaver 路径走查通过；`pytest` + `ruff` 全绿。
- [ ] 全程只动 `agents/bidding_agent/` + 一处 `base_agent.py`；`bidding_agent` 仍唯一 agent_type。
