# spec105 · 智能体编写框架 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立**我们自己的、精简的智能体编写框架**：`BaseAgent` 基类 + Hook 中间件管线 + 可插拔 Backend 协议 + 健壮性层（resilient tool node）+ 上下文压缩节点 + 结构化输出 submit-tool + HITL 人机交互帮助器。新增智能体 = 写一个 `BaseAgent` 子类 + 注册，复用全部框架层。投标读标（spec107）是第一个使用者。

**Architecture:** 框架是 LangGraph 之上的一层"编写约定"：`BaseAgent._compile()` 把 `agent_node`（跑 Hook 管线 + LLM 调用）、`resilient_tool_node`、可选 `compressor` 节点接成图；`astream(input, ctx)` 适配 spec104 的 `AgentProtocol`（用 ctx 的 checkpointer/recorder/gateway），把 LangGraph 流转成我们的事件、检测 `interrupt` 发 `hitl.required`。框架支持**两类节点**：create_agent 式（确定性）与 **deepagent 式**（动态规划 + 子智能体 + 虚拟 FS）——两者都是 `CompiledStateGraph`，同一 `astream` 驱动。**不引入 agent 层计费**（钱只在 App，§3.2）。

**Tech Stack:** LangGraph、langchain-core、Pydantic、pytest（+pytest-asyncio）。

## Global Constraints

见 `spec100-index.md`。本 spec 关键约束：
- 框架**与具体智能体解耦**；只提供原语，不含投标业务。
- 复用 spec102 `Recorder`（埋点）、spec103 `ModelGateway`（模型）、spec104 `AgentProtocol`/`RunContext`/`get_checkpointer`/HITL `/resume`。
- Backend 默认 **in-state 虚拟 FS、`execute` 关闭**（§4.5）；DB/MinIO 后端按需另接。
- **不碰钱**：不做 agent 层预扣/退款/定价；只上报 usage。
- 在 `main` 上先开分支；提交信息结尾附 Co-Authored-By。

---

## File Structure

```
services/agent/src/agent/framework/
├── __init__.py
├── hooks.py            # AgentHook(pre/post) + AgentTurnContext + 内置钩子
├── backend.py          # Backend 协议 + InStateBackend + create_backend_tools(execute 关)
├── resilient.py        # resilient_tool_node(错误转 ToolMessage + 工具门)
├── compressor.py       # 上下文压缩节点(保近 + 摘中)
├── structured.py       # make_submit_tool(Pydantic 强约束输出)
├── hitl.py             # human_review/interrupt 封装 + review 类型 + resume 协议
├── create_agent.py     # build_create_agent:prompt+tools→可 ainvoke 子图
├── base_agent.py       # BaseAgent:建图 + agent_node + astream/aresume + 注册（create_agent 式）
└── deepagent.py        # DeepAgent:deepagent 式节点（动态规划 + 子智能体 + 虚拟 FS）
services/agent/tests/framework/
├── test_hooks.py  test_backend.py  test_resilient.py
├── test_structured.py  test_hitl.py  test_compressor.py
└── test_base_agent.py  # 示例 agent 端到端 + HITL
```

---

## Interfaces（本 spec 对外产出，供 spec107 写投标 agent）

- Produces：
  - `AgentHook`（`pre_invoke(ctx)`/`post_invoke(ctx)`）、`AgentTurnContext`、`run_turn(hooks, llm, state, config) -> AgentTurnContext`。
  - `Backend`(Protocol)、`InStateBackend`、`create_backend_tools(backend, *, allow_execute=False) -> list[Tool]`。
  - `resilient_tool_node(tools) -> node`。
  - `make_submit_tool(name, schema: type[BaseModel], description) -> (Tool, getter)`。
  - `human_review(review_type, details, *, timeout_seconds=None) -> dict`；`ReviewType`。
  - `make_compressor_node(gateway, *, max_tokens, keep_recent) -> node`。
  - `BaseAgent`（create_agent 式）：子类设 `agent_type` + 实现 `build(ctx)`（给提示词/工具/钩子）；框架提供 `astream(input, ctx)`、`aresume(value, ctx)`，并在 `__init_subclass__` 自动 `register`。
  - `DeepAgent(BaseAgent)`（deepagent 式）：子类实现 `deep_build(ctx)`（给 instructions/tools/subagents）；框架用动态规划(todos) + 子智能体(task) + 虚拟 FS 编译成图，复用同一 `astream`/registry/观测/HITL。
  - `build_create_agent(prompt: str, tools: list, ctx) -> CompiledStateGraph`（`framework/create_agent.py`）：把「提示词 + 工具」编成一个**可 `ainvoke` 的 create_agent 子图**（含 agent_node + resilient_tool_node 循环、走 ctx 的 gateway/recorder，不含 checkpointer/interrupt）。供 **Phase 2 工作流节点**（提纲/审查/述标等，spec202/204/205）在图节点内部跑确定性子 agent 用；也是 `BaseAgent._compile_single_loop` 的底层。

---

## Task 1: Hook 管线（hooks.py）

**Files:** Create `framework/__init__.py`、`framework/hooks.py`、`tests/framework/test_hooks.py`

- [ ] **Step 1: 开分支 + 目录**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout -b phase1/spec105-framework
mkdir -p services/agent/src/agent/framework services/agent/tests/framework
touch services/agent/src/agent/framework/__init__.py
```

- [ ] **Step 2: 失败测试 `tests/framework/test_hooks.py`**

```python
import asyncio
from langchain_core.messages import HumanMessage, SystemMessage
from agent.framework.hooks import AgentHook, AgentTurnContext, run_turn, BuildMessagesHook


class _FakeLLM:
    async def ainvoke(self, messages):
        from langchain_core.messages import AIMessage
        return AIMessage(content="ok")


class _OrderHook(AgentHook):
    def __init__(self, log): self.log = log
    async def pre_invoke(self, ctx): self.log.append("pre")
    async def post_invoke(self, ctx): self.log.append("post")


def test_run_turn_order_and_system_prompt():
    log = []
    state = {"messages": [HumanMessage(content="hi")]}
    hooks = [BuildMessagesHook("SYS"), _OrderHook(log)]
    ctx = asyncio.run(run_turn(hooks, _FakeLLM(), state, None))
    assert log == ["pre", "post"]                       # pre 全跑→LLM→post 全跑
    assert isinstance(ctx.messages[0], SystemMessage)    # 系统提示注入
    assert ctx.result.content == "ok"                    # LLM 结果在 ctx
```

- [ ] **Step 3: 实现 `framework/hooks.py`**

```python
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from langchain_core.messages import SystemMessage


@dataclass
class AgentTurnContext:
    state: dict
    config: Any = None
    messages: list = field(default_factory=list)
    llm: Any = None
    result: Any = None                       # LLM 调用后的 AIMessage
    output_extras: dict = field(default_factory=dict)


class AgentHook:
    async def pre_invoke(self, ctx: AgentTurnContext) -> None: ...
    async def post_invoke(self, ctx: AgentTurnContext) -> None: ...


class BuildMessagesHook(AgentHook):
    """注入系统提示 + 用历史拼消息。"""
    def __init__(self, prompt: str | None = None):
        self._prompt = prompt

    async def pre_invoke(self, ctx: AgentTurnContext) -> None:
        history = list(ctx.state.get("messages", []))
        ctx.messages = ([SystemMessage(content=self._prompt)] + history) if self._prompt else history


class DropMalformedToolCallsHook(AgentHook):
    """丢弃模型产出的畸形 tool call（无 name/args），避免下游崩。"""
    async def post_invoke(self, ctx: AgentTurnContext) -> None:
        res = ctx.result
        calls = getattr(res, "tool_calls", None)
        if calls:
            good = [c for c in calls if c.get("name")]
            if len(good) != len(calls):
                res.tool_calls = good


async def run_turn(hooks: list[AgentHook], llm: Any, state: dict, config: Any) -> AgentTurnContext:
    ctx = AgentTurnContext(state=state, config=config, llm=llm)
    for h in hooks:
        await h.pre_invoke(ctx)
    ctx.result = await ctx.llm.ainvoke(ctx.messages)   # 钩子可在 pre 改 ctx.llm（如绑 tool_choice）
    for h in hooks:
        await h.post_invoke(ctx)
    return ctx
```

- [ ] **Step 4: 通过 + 提交**

Run: `cd services/agent && uv run pytest tests/framework/test_hooks.py -q` → 1 passed
```bash
git add services/agent/src/agent/framework/__init__.py services/agent/src/agent/framework/hooks.py services/agent/tests/framework/test_hooks.py
git commit -m "feat(spec105): Hook 管线(pre/post + 内置钩子)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Backend 协议 + InStateBackend + 工具（backend.py）

**Files:** Create `framework/backend.py`、`tests/framework/test_backend.py`

- [ ] **Step 1: 失败测试 `tests/framework/test_backend.py`**

```python
import asyncio
from agent.framework.backend import InStateBackend, create_backend_tools


def test_in_state_backend_roundtrip():
    b = InStateBackend()

    async def run():
        await b.write_file("/SOUL.md", "hello")
        assert await b.read_file("/SOUL.md") == "hello"
        await b.edit_file("/SOUL.md", "hello", "world")
        assert await b.read_file("/SOUL.md") == "world"
        assert "/SOUL.md" in await b.list_files("/")

    asyncio.run(run())


def test_create_backend_tools_no_execute_by_default():
    tools = create_backend_tools(InStateBackend())
    names = {t.name for t in tools}
    assert {"read_file", "write_file", "edit_file", "list_files"} <= names
    assert "execute" not in names           # 默认不开 shell（§4.5）
```

- [ ] **Step 2: 实现 `framework/backend.py`**

```python
from __future__ import annotations

import fnmatch
from typing import Protocol
from langchain_core.tools import StructuredTool


class Backend(Protocol):
    async def read_file(self, path: str) -> str: ...
    async def write_file(self, path: str, content: str) -> None: ...
    async def edit_file(self, path: str, old_str: str, new_str: str) -> str: ...
    async def list_files(self, path: str = "/") -> list[str]: ...
    async def grep(self, pattern: str, path: str = "/") -> list[str]: ...


class InStateBackend:
    """默认后端：内存虚拟文件系统（按 run 实例化；可由 BaseAgent 与 state 同步）。"""
    def __init__(self, files: dict[str, str] | None = None):
        self._files = dict(files or {})

    async def read_file(self, path: str) -> str:
        if path not in self._files:
            raise FileNotFoundError(path)
        return self._files[path]

    async def write_file(self, path: str, content: str) -> None:
        self._files[path] = content

    async def edit_file(self, path: str, old_str: str, new_str: str) -> str:
        cur = await self.read_file(path)
        if old_str not in cur:
            raise ValueError(f"old_str not found in {path}")
        self._files[path] = cur.replace(old_str, new_str, 1)
        return self._files[path]

    async def list_files(self, path: str = "/") -> list[str]:
        return sorted(self._files.keys())

    async def grep(self, pattern: str, path: str = "/") -> list[str]:
        return [p for p, c in self._files.items() if pattern in c]

    def snapshot(self) -> dict[str, str]:
        return dict(self._files)


def create_backend_tools(backend: Backend, *, allow_execute: bool = False) -> list:
    """把 backend 长出文件工具（execute 默认不开，§4.5）。"""
    async def read_file(path: str) -> str: return await backend.read_file(path)
    async def write_file(path: str, content: str) -> str:
        await backend.write_file(path, content); return f"written {path}"
    async def edit_file(path: str, old_str: str, new_str: str) -> str:
        return await backend.edit_file(path, old_str, new_str)
    async def list_files(path: str = "/") -> str:
        return "\n".join(await backend.list_files(path))
    tools = [
        StructuredTool.from_function(coroutine=read_file, name="read_file", description="读取虚拟文件"),
        StructuredTool.from_function(coroutine=write_file, name="write_file", description="写入虚拟文件"),
        StructuredTool.from_function(coroutine=edit_file, name="edit_file", description="按字符串替换编辑文件"),
        StructuredTool.from_function(coroutine=list_files, name="list_files", description="列出文件"),
    ]
    # allow_execute=True 时才接入 shell 后端（需 OpenSandbox，§4.5）；本框架默认不开。
    return tools
```

- [ ] **Step 3: 通过 + 提交**

Run: `cd services/agent && uv run pytest tests/framework/test_backend.py -q` → 2 passed
```bash
git add services/agent/src/agent/framework/backend.py services/agent/tests/framework/test_backend.py
git commit -m "feat(spec105): Backend 协议 + InStateBackend + create_backend_tools(execute 关)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: resilient tool node（resilient.py）

**Files:** Create `framework/resilient.py`、`tests/framework/test_resilient.py`

- [ ] **Step 1: 失败测试 `tests/framework/test_resilient.py`**

```python
import asyncio
from langchain_core.messages import AIMessage
from langchain_core.tools import StructuredTool
from agent.framework.resilient import resilient_tool_node


async def _boom(x: str) -> str:
    raise RuntimeError("kaboom")


def test_tool_error_becomes_tool_message():
    tool = StructuredTool.from_function(coroutine=_boom, name="boom", description="x")
    node = resilient_tool_node([tool])
    ai = AIMessage(content="", tool_calls=[{"name": "boom", "args": {"x": "1"}, "id": "c1"}])
    out = asyncio.run(node({"messages": [ai]}))
    msgs = out["messages"]
    assert msgs[0].status == "error" and "kaboom" in msgs[0].content   # 不抛、转 ToolMessage 错误
```

- [ ] **Step 2: 实现 `framework/resilient.py`**

```python
from __future__ import annotations

from langgraph.prebuilt import ToolNode


def _fmt(exc: Exception) -> str:
    return f"工具执行失败: {type(exc).__name__}: {exc}"


def resilient_tool_node(tools: list):
    """LangGraph ToolNode 包装：工具失败转成 status=error 的 ToolMessage（不让异常炸图）。
    支持 config.configurable.allowed_tools / disallowed_tools 做工具门（None=全允许）。"""
    node = ToolNode(tools, handle_tool_errors=_fmt)

    async def _invoke(state, config=None):
        conf = (config or {}).get("configurable", {}) if config else {}
        allowed = conf.get("allowed_tools")
        disallowed = set(conf.get("disallowed_tools") or [])
        if allowed is None and not disallowed:
            return await node.ainvoke(state, config=config)
        # 过滤未授权 tool_call → 直接回 error ToolMessage（不执行）
        from langchain_core.messages import ToolMessage
        msgs = state.get("messages") or []
        calls = list(getattr(msgs[-1], "tool_calls", []) or []) if msgs else []
        allow = ({getattr(t, "name", "") for t in tools} if allowed is None else set(allowed)) - disallowed
        out, ok_calls = [], []
        for c in calls:
            if c.get("name") in allow:
                ok_calls.append(c)
            else:
                out.append(ToolMessage(content=_fmt(PermissionError(f"tool '{c.get('name')}' not allowed")),
                                       tool_call_id=c.get("id") or "", name=c.get("name") or "", status="error"))
        if ok_calls:
            msgs[-1].tool_calls = ok_calls
            res = await node.ainvoke(state, config=config)
            out = list(res.get("messages") or []) + out
        return {"messages": out}

    return _invoke
```

- [ ] **Step 3: 通过 + 提交**

Run: `cd services/agent && uv run pytest tests/framework/test_resilient.py -q` → passed
```bash
git add services/agent/src/agent/framework/resilient.py services/agent/tests/framework/test_resilient.py
git commit -m "feat(spec105): resilient tool node(错误转 ToolMessage + 工具门)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 结构化输出 submit-tool（structured.py）

**Files:** Create `framework/structured.py`、`tests/framework/test_structured.py`

- [ ] **Step 1: 失败测试 `tests/framework/test_structured.py`**

```python
import asyncio
from pydantic import BaseModel
from agent.framework.structured import make_submit_tool


class ReadResult(BaseModel):
    categories: list[str]
    risks: list[str]


def test_submit_tool_validates_and_captures():
    tool, get_last = make_submit_tool("submit_read", ReadResult, "提交读标结果")
    out = asyncio.run(tool.ainvoke({"categories": ["技术标"], "risks": ["资质缺失"]}))
    assert "submit_read" in out
    last = get_last()
    assert isinstance(last, ReadResult) and last.categories == ["技术标"]


def test_submit_tool_rejects_invalid():
    tool, _ = make_submit_tool("submit_read", ReadResult, "x")
    import pytest
    with pytest.raises(Exception):
        asyncio.run(tool.ainvoke({"categories": "not-a-list"}))
```

- [ ] **Step 2: 实现 `framework/structured.py`**

```python
from __future__ import annotations

from typing import Callable
from pydantic import BaseModel
from langchain_core.tools import StructuredTool


def make_submit_tool(name: str, schema: type[BaseModel], description: str):
    """生成一个"结构化提交"工具：模型按 schema 调用 → 强校验 → 捕获结果。
    返回 (tool, get_last)。配 force tool_choice 即可强约束模型按 schema 产出（DeckSpec/读标结果等）。"""
    captured: dict = {}

    async def _submit(**kwargs) -> str:
        obj = schema(**kwargs)         # Pydantic 校验，不合法即抛
        captured["value"] = obj
        return f"{name} accepted"

    tool = StructuredTool.from_function(coroutine=_submit, name=name, description=description, args_schema=schema)

    def get_last() -> BaseModel | None:
        return captured.get("value")

    return tool, get_last
```

- [ ] **Step 3: 通过 + 提交**

Run: `cd services/agent && uv run pytest tests/framework/test_structured.py -q` → 2 passed
```bash
git add services/agent/src/agent/framework/structured.py services/agent/tests/framework/test_structured.py
git commit -m "feat(spec105): 结构化输出 submit-tool(Pydantic 强约束)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: HITL（hitl.py）

**Files:** Create `framework/hitl.py`、`tests/framework/test_hitl.py`

- [ ] **Step 1: 失败测试 `tests/framework/test_hitl.py`**

```python
from agent.framework import hitl


def test_human_review_builds_interrupt_payload(monkeypatch):
    captured = {}
    monkeypatch.setattr(hitl, "interrupt", lambda v: captured.setdefault("v", v) or v)
    hitl.human_review(hitl.ReviewType.OUTLINE_CONFIRM, {"outline": ["第一章"]}, timeout_seconds=120)
    v = captured["v"]
    assert v["type"] == "hitl.required"
    assert v["review_type"] == "outline_confirm"
    assert v["details"]["outline"] == ["第一章"]
    assert v["timeout_seconds"] == 120
```

- [ ] **Step 2: 实现 `framework/hitl.py`**

```python
from __future__ import annotations

from enum import StrEnum
from typing import Any
from dataclasses import asdict, is_dataclass
from langgraph.types import interrupt


class ReviewType(StrEnum):
    """投标场景的人审类型（前端按此选渲染模板）。"""
    OUTLINE_CONFIRM = "outline_confirm"      # 读标→提纲后，确认大纲再写正文
    CHAPTER_REVIEW = "chapter_review"        # 关键章节回审
    GENERIC_CONFIRM = "generic_confirm"      # 通用确认


def human_review(review_type: ReviewType | str, details: Any, *, timeout_seconds: int | None = None,
                 default_action: str = "approve") -> dict:
    """在图节点内调用：interrupt 暂停 run、发 hitl.required 给前端、等 /resume 回灌。
    resume 协议：{"action":"approve"} | {"action":"modify","feedback":"...","data":{...}}。
    返回前端 resume 的 dict。"""
    payload = {
        "type": "hitl.required",
        "review_type": str(review_type),
        "details": asdict(details) if is_dataclass(details) else details,
        "timeout_seconds": timeout_seconds,
        "default_action": default_action,
    }
    return interrupt(payload)
```

- [ ] **Step 3: 通过 + 提交**

Run: `cd services/agent && uv run pytest tests/framework/test_hitl.py -q` → passed
```bash
git add services/agent/src/agent/framework/hitl.py services/agent/tests/framework/test_hitl.py
git commit -m "feat(spec105): HITL human_review(interrupt 封装 + 投标 review 类型)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 上下文压缩节点（compressor.py）

**Files:** Create `framework/compressor.py`、`tests/framework/test_compressor.py`

- [ ] **Step 1: 失败测试 `tests/framework/test_compressor.py`**

```python
import asyncio
from langchain_core.messages import HumanMessage, AIMessage
from agent.framework.compressor import make_compressor_node


class _FakeGateway:
    def invoke(self, messages, **kw):
        return AIMessage(content="摘要：前文略")


def test_compressor_keeps_recent_and_summarizes_when_over():
    node = make_compressor_node(_FakeGateway(), max_tokens=20, keep_recent=2)
    msgs = [HumanMessage(content="x" * 50), AIMessage(content="a"), HumanMessage(content="b"), AIMessage(content="c")]
    out = asyncio.run(node({"messages": msgs}))
    new = out["messages"]
    # 压缩：保留最近 2 条 + 1 条摘要在前
    assert new[-2].content == "b" and new[-1].content == "c"
    assert "摘要" in new[0].content


def test_compressor_noop_when_under():
    node = make_compressor_node(_FakeGateway(), max_tokens=10_000, keep_recent=2)
    msgs = [HumanMessage(content="hi")]
    out = asyncio.run(node({"messages": msgs}))
    assert out == {} or out.get("messages") in (None, msgs)  # 未超阈值不改
```

- [ ] **Step 2: 实现 `framework/compressor.py`**

```python
from __future__ import annotations

from typing import Any
from langchain_core.messages import AIMessage, SystemMessage


def _size(messages: list) -> int:
    return sum(len(str(getattr(m, "content", "") or "")) for m in messages)


def make_compressor_node(gateway: Any, *, max_tokens: int = 60_000, keep_recent: int = 6):
    """超阈值时：保留最近 keep_recent 条，把更早的摘要成一条 SystemMessage 放最前。
    Phase 1 用字符数近似 token（阈值名 max_tokens 与调用方 spec203 对齐）；后续可换真实 tokenizer。"""
    async def _node(state: dict) -> dict:
        msgs = list(state.get("messages") or [])
        if _size(msgs) <= max_tokens or len(msgs) <= keep_recent:
            return {}
        head, recent = msgs[:-keep_recent], msgs[-keep_recent:]
        summary = gateway.invoke(
            [SystemMessage(content="把以下对话压成要点摘要，保留关键事实/决定："), *head]
        )
        compacted = [SystemMessage(content=f"[历史摘要] {summary.content}"), *recent]
        return {"messages": compacted}
    return _node
```

- [ ] **Step 3: 通过 + 提交**

Run: `cd services/agent && uv run pytest tests/framework/test_compressor.py -q` → 2 passed
```bash
git add services/agent/src/agent/framework/compressor.py services/agent/tests/framework/test_compressor.py
git commit -m "feat(spec105): 上下文压缩节点(保近 + 摘中)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: BaseAgent 组装 + 示例 agent 端到端（base_agent.py）

**Files:** Create `framework/create_agent.py`、`framework/base_agent.py`、`tests/framework/test_base_agent.py`

**Interfaces:**
- Consumes: spec104 `RunContext`/`register`/`get_checkpointer`；本 spec 各原语。
- Produces: `BaseAgent`（子类化 = 新 agent_type）；`build_create_agent(prompt, tools, ctx) -> CompiledStateGraph`（可 `ainvoke` 的确定性子图）。

> **先抽出 `framework/create_agent.py` 的 `build_create_agent(prompt, tools, ctx)`**：用 `StateGraph` 接 `agent_node`（`run_turn` 跑 Hook + `ctx.gateway` LLM）+ `resilient_tool_node(tools)` + `tools_condition` 成环，`compile()`（**不带 checkpointer/interrupt**），返回可 `ainvoke({"messages":[...]})` 的子图。`BaseAgent._compile_single_loop` 复用它（再叠 checkpointer）；Phase 2 工作流节点（spec202/204/205）在节点内直接调它跑确定性子 agent。下面 Step 1 的建图逻辑即据此拆分。

- [ ] **Step 1: 实现 `framework/base_agent.py`**

```python
from __future__ import annotations

from typing import Any, AsyncIterator
from dataclasses import dataclass, field
from langchain_core.messages import HumanMessage
from langgraph.graph import StateGraph, START, END
from langgraph.prebuilt import tools_condition
from langgraph.graph.message import add_messages
from typing import Annotated, TypedDict
from agent.framework.hooks import AgentHook, run_turn, BuildMessagesHook, DropMalformedToolCallsHook
from agent.framework.resilient import resilient_tool_node
from agent.runtime.registry import register, RunContext
from agent.models.usage import extract_usage


class GraphState(TypedDict):
    messages: Annotated[list, add_messages]


@dataclass
class AgentBuild:
    """子类 build() 返回：提示词 + 工具 + 额外钩子 + 可选压缩节点。"""
    prompt: str
    tools: list = field(default_factory=list)
    extra_hooks: list[AgentHook] = field(default_factory=list)
    compressor: Any = None


class BaseAgent:
    agent_type: str = ""

    def __init_subclass__(cls, **kw):
        super().__init_subclass__(**kw)
        if getattr(cls, "agent_type", ""):
            register(cls.agent_type, cls)        # 子类即注册一个 agent_type

    def build(self, ctx: RunContext) -> AgentBuild:
        raise NotImplementedError

    def _compile(self, ctx: RunContext, checkpointer):
        b = self.build(ctx)
        llm = ctx.gateway.get_chat(provider=None) if ctx.gateway else None
        llm_with_tools = llm.bind_tools(b.tools) if (llm and b.tools) else llm
        hooks = [BuildMessagesHook(b.prompt), DropMalformedToolCallsHook(), *b.extra_hooks]

        async def agent_node(state, config=None):
            turn = await run_turn(hooks, llm_with_tools, state, config)
            # 框架统一埋点：agent_node 走 get_chat(...).ainvoke 绕过了 gateway.invoke，
            # 这里补记 token 用量，否则真实 run 不上报、spec108 settle 永远汇总 0。
            if ctx.recorder is not None and ctx.run_id:
                u = extract_usage(turn.result)
                _s = getattr(ctx.gateway, "s", None) if ctx.gateway else None
                ctx.recorder.record_usage(
                    ctx.run_id, ctx.agent_type,
                    provider=getattr(_s, "model_default_provider", None),
                    model=getattr(llm, "model_name", None),
                    input_tokens=u["input"], output_tokens=u["output"], cached_tokens=u["cached"],
                    reasoning_tokens=u["reasoning"], total_tokens=u["total"], node="agent",
                    ttft_ms=None,                         # 流式接入后填
                    finish_reason=u["finish_reason"], thread_id=ctx.thread_id,
                )
            return {"messages": [turn.result]}

        g = StateGraph(GraphState)
        if b.compressor:
            g.add_node("compressor", b.compressor); g.add_edge(START, "compressor"); g.add_edge("compressor", "agent")
        else:
            g.add_edge(START, "agent")
        g.add_node("agent", agent_node)
        if b.tools:
            g.add_node("tools", resilient_tool_node(b.tools))
            g.add_conditional_edges("agent", tools_condition, {"tools": "tools", END: END})
            g.add_edge("tools", "agent")
        else:
            g.add_edge("agent", END)
        return g.compile(checkpointer=checkpointer)

    async def astream(self, input: dict, ctx: RunContext) -> AsyncIterator[dict]:
        from agent.checkpointer import get_checkpointer
        graph = self._compile(ctx, await get_checkpointer())
        config = {"configurable": {"thread_id": ctx.thread_id}}
        init = {"messages": [HumanMessage(content=str(input.get("text", input)))]}
        async for mode, chunk in graph.astream(init, config=config, stream_mode=["updates", "messages"]):
            if mode == "messages":
                msg, _meta = chunk
                if getattr(msg, "content", ""):
                    yield {"type": "chunk", "node": "agent", "data": {"delta": msg.content}}
            elif mode == "updates":
                if "__interrupt__" in chunk:                  # HITL
                    intr = chunk["__interrupt__"][0]
                    yield {"type": "hitl.required", "data": getattr(intr, "value", intr)}
                    return
                for node, val in chunk.items():
                    yield {"type": "node.end", "node": node,
                           "data": {"result": _final_text(val)}}

    async def aresume(self, value: Any, ctx: RunContext) -> AsyncIterator[dict]:
        from agent.checkpointer import get_checkpointer
        from langgraph.types import Command
        graph = self._compile(ctx, await get_checkpointer())
        config = {"configurable": {"thread_id": ctx.thread_id}}
        async for mode, chunk in graph.astream(Command(resume=value), config=config, stream_mode=["updates", "messages"]):
            if mode == "messages":
                msg, _ = chunk
                if getattr(msg, "content", ""):
                    yield {"type": "chunk", "node": "agent", "data": {"delta": msg.content}}


def _final_text(val: Any) -> Any:
    if isinstance(val, dict):
        msgs = val.get("messages")
        if msgs:
            return getattr(msgs[-1], "content", None)
    return None
```

> `astream(input, ctx)` 与 spec104 `AgentProtocol` 对齐，executor 直接驱动；`aresume` 供 spec104 worker 的 resume 分支调用。

> **框架统一埋点（已含在上面 `agent_node`）**：`agent_node` 经 `run_turn` 走 `get_chat(...).ainvoke`，绕过了唯一会 `record_usage` 的 `gateway.invoke`。所以在拿到 LLM 响应后用 `extract_usage(turn.result)` 取用量并 `ctx.recorder.record_usage(... node="agent", ttft_ms=None ...)`（字段对齐 spec102 `agent_token_usage`：input/output/cached/reasoning/total + ttft_ms/latency_ms；ttft 待流式接入后填）。否则真实 run 不上报 token、spec108 settle 永远汇总 0。

- [ ] **Step 2: 写示例 agent 端到端测试 `tests/framework/test_base_agent.py`（fake gateway + 真 checkpointer）**

```python
import asyncio
from langchain_core.messages import AIMessage
from agent.framework.base_agent import BaseAgent, AgentBuild
from agent.runtime.registry import RunContext, get_agent
from agent.telemetry.recorder import Recorder
from agent.db import pool


class _FakeChat:
    def bind_tools(self, tools): return self
    async def ainvoke(self, messages): return AIMessage(content="你好，我是示例 agent")


class _FakeGateway:
    def get_chat(self, provider=None, model=None, **kw): return _FakeChat()


class EchoFrameworkAgent(BaseAgent):
    agent_type = "echo_fw"
    def build(self, ctx):
        return AgentBuild(prompt="你是示例", tools=[])


def test_framework_agent_streams_via_graph():
    agent = get_agent("echo_fw")                       # __init_subclass__ 已注册
    ctx = RunContext(run_id="r-fw", agent_type="echo_fw", thread_id="t-fw",
                     recorder=Recorder(pool), gateway=_FakeGateway())

    async def run():
        return [ev async for ev in agent.astream({"text": "hi"}, ctx)]

    evs = asyncio.run(run())
    chunks = [e for e in evs if e["type"] == "chunk"]
    assert any("示例 agent" in (c["data"]["delta"] or "") for c in chunks)
```

- [ ] **Step 3: 通过 + 全量 + lint**

Run: `cd services/agent && uv run pytest tests/framework -q && uv run ruff check src`
Expected: 全 passed，ruff 无错。

- [ ] **Step 4: 提交并合并**

```bash
git add services/agent/src/agent/framework/base_agent.py services/agent/tests/framework/test_base_agent.py
git commit -m "feat(spec105): BaseAgent 组装(图/钩子/工具/HITL)+ 示例 agent 端到端

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: deepagent 式节点支持（deepagent.py）

> 投标里"正文生成"等开放式节点需要**动态规划 + 子智能体 + 虚拟 FS**——这类节点用 deepagent 式。它编出来同样是 `CompiledStateGraph`，复用 BaseAgent 的 `astream`/注册/观测/HITL，与 create_agent 式节点在同一框架内并存（§4.2）。

**Files:** Modify `pyproject.toml`；Create `framework/deepagent.py`、`tests/framework/test_deepagent.py`

- [ ] **Step 1: 装 deepagents**

```bash
cd services/agent && uv add deepagents
```

- [ ] **Step 2: 写 `framework/deepagent.py`**

```python
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from deepagents import create_deep_agent     # 动态规划(todos)+子智能体(task)+虚拟FS
from agent.framework.base_agent import BaseAgent
from agent.runtime.registry import RunContext


@dataclass
class DeepBuild:
    instructions: str
    tools: list = field(default_factory=list)
    subagents: list = field(default_factory=list)   # 子智能体定义（可空）


class DeepAgent(BaseAgent):
    """deepagent 式节点基类：子类实现 deep_build()。
    deepagents 默认用 in-state 虚拟文件系统、不开 execute（与 §4.5 一致），
    可随 checkpointer 续跑（§4.7：虚拟 FS 在图 state 内）。"""

    def deep_build(self, ctx: RunContext) -> DeepBuild:
        raise NotImplementedError

    def _compile(self, ctx: RunContext, checkpointer):
        cfg = self.deep_build(ctx)
        model = ctx.gateway.get_chat(provider=None) if ctx.gateway else None
        # 注：create_deep_agent 的确切 kwargs 随 deepagents 版本，落地时核对
        # （tools / instructions / model / subagents / checkpointer）。
        return create_deep_agent(
            tools=cfg.tools,
            instructions=cfg.instructions,
            model=model,
            subagents=cfg.subagents or None,
            checkpointer=checkpointer,
        )
```

> 关键：`DeepAgent` 只覆写 `_compile` 返回一个 deepagent（`CompiledStateGraph`）；`astream`/`aresume`（spec105 Task 7）原样驱动它——deepagent 的规划/子智能体/虚拟 FS 事件都从 LangGraph `updates` 流出。所以 **create_agent 式与 deepagent 式节点共用同一套 run 契约、观测、HITL**。

- [ ] **Step 3: 写测试 `tests/framework/test_deepagent.py`**

```python
import os
import pytest
from agent.framework.deepagent import DeepAgent, DeepBuild
from agent.runtime.registry import get_agent, RunContext
from agent.telemetry.recorder import Recorder
from agent.db import pool


class DemoDeepAgent(DeepAgent):
    agent_type = "demo_deep"
    def deep_build(self, ctx):
        return DeepBuild(instructions="你是一个会规划的助手。", tools=[])


def test_deepagent_registers():
    assert get_agent("demo_deep").__class__.__name__ == "DemoDeepAgent"   # 子类化即注册


def test_deepagent_compiles_to_graph():
    # 结构性：能编译成带 astream 的图（不发真实模型请求）
    from langchain_core.language_models.fake_chat_models import FakeListChatModel

    class _GW:
        def get_chat(self, provider=None, model=None, **kw):
            return FakeListChatModel(responses=["规划完成"])

    ctx = RunContext(run_id="r", agent_type="demo_deep", thread_id="t",
                     recorder=Recorder(pool), gateway=_GW())
    graph = get_agent("demo_deep")._compile(ctx, checkpointer=None)
    assert hasattr(graph, "astream")


@pytest.mark.skipif(not os.getenv("DEEPSEEK_API_KEY"), reason="需要真实模型 Key")
def test_deepagent_real_smoke():
    # 可选：配了 Key 时跑一次真实 deepagent（规划+回答）
    ...
```

> deepagents 真正运行需要能规划的模型；无 Key 时只做"注册 + 可编译"结构性校验，真实执行作可选冒烟（与 spec103 同思路）。`FakeListChatModel` 用于结构性编译，若该版本 deepagents 对模型有更强约束，则把 `test_deepagent_compiles_to_graph` 也标 `skipif` 走真实 Key。

- [ ] **Step 4: 通过 + 提交**

Run: `cd services/agent && uv run pytest tests/framework/test_deepagent.py -q` → 注册 + 可编译通过（真实冒烟按 Key 跳过）
```bash
git add services/agent/pyproject.toml services/agent/src/agent/framework/deepagent.py services/agent/tests/framework/test_deepagent.py
git commit -m "feat(spec105): deepagent 式节点支持(动态规划/子智能体/虚拟FS，共用 astream)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: 全量测试 + 合并（spec105 收尾）**

Run: `cd services/agent && uv run pytest tests/framework -q && uv run ruff check src`
Expected: 全 passed，ruff 无错。

```bash
git checkout main
git merge --no-ff phase1/spec105-framework -m "merge spec105: 智能体编写框架"
git push origin main
```

---

## 验收清单（spec105 完成判据）

- [ ] Hook 管线：pre/post 顺序正确；内置 BuildMessages（注入系统提示）、DropMalformedToolCalls 生效。
- [ ] Backend 协议 + InStateBackend 读写编辑/列举；`create_backend_tools` 默认**不含 execute**。
- [ ] resilient tool node：工具异常转 `status=error` ToolMessage（不炸图）；allowed/disallowed 工具门。
- [ ] submit-tool：Pydantic 强校验，合法捕获、非法抛错。
- [ ] HITL `human_review` 构造正确 interrupt 载荷（hitl.required + review_type + details）；resume 协议 approve/modify。
- [ ] 压缩节点：超阈值保近 + 摘中，未超不动。
- [ ] `BaseAgent`（create_agent 式）子类化即注册 agent_type；`astream(input, ctx)` 经 LangGraph + checkpointer 出事件、检测 interrupt；`aresume` 续跑。
- [ ] `DeepAgent`（deepagent 式）覆写 `_compile` 返回 deepagent（动态规划/子智能体/虚拟 FS），**复用同一 `astream`/注册/观测/HITL**；注册 + 可编译校验通过。
- [ ] **无 agent 层计费**（钱只在 App，只上报 usage）。
- [ ] `uv run pytest tests/framework` + `ruff` 全绿。
