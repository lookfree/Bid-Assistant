# spec202 · 提纲 outline 节点 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 spec201 的 `outline` stub 替换为真实节点：读 `state['read']`（读标结论）→ 生成**技术标/商务标提纲**（章—节两级，标注来源/新增）→ 用 `submit_outline` 产出 `Outline` 写入 `state['outline']`。结构逐字对齐 C 端 `/outline` 原型（`sample-bid.ts: chapters / OutlineItem`）。create_agent 式（结构化生成，可加轻量规划）。

**Architecture:** `make_outline_node(ctx)` 内部用 `build_create_agent`（spec105）跑一个挂了 `submit_outline(Outline)` 工具的子 agent；系统提示喂入读标结论（评分项、★不可偏离、废标红线），要求产出覆盖评分点的章节大纲，并对每章标 `sourced`（能否在招标文件索引到来源）、每个子项标 `is_new`（提纲新增）。

**Tech Stack:** spec105 框架（create_agent + make_submit_tool）、spec201 图、Pydantic、pytest。

## 前端交互对齐（依据 C 端原型 `/outline`）

- 提纲分**技术标 / 商务标**两组；每章 `{ id(t1../b1..), no(第N章), title, group, sourced }`。
- 每章下子项 `OutlineItem { id, label(如「1.1 项目背景与需求理解」), clause_ids(招标依据条款 id，对齐原型 clauseIds), is_new(提纲新增) }`。
- `sourced=false` 的章（如技术标「应急预案」、商务标「售后服务」）= 提纲新增、正文待生成（对应原型空状态章）。
- 提纲覆盖评分办法表的得分点（评分项→章节，对应原型 `scoringMap`）。

## Global Constraints

见 `spec200-index.md`。关键：只动 `agents/bidding_agent/`；读 `state['read']` 产 `state['outline']`，不碰钱；产出对齐原型；TDD；先开分支。

---

## File Structure

```
services/agent/src/agent/agents/bidding_agent/
├── schemas.py                # 改：加 OutlineItem / OutlineChapter / Outline
├── prompts/outline.py        # 新：OUTLINE_SYSTEM_PROMPT
└── nodes/outline.py          # 改：stub → 真实 make_outline_node
services/agent/tests/agents/bidding_agent/
├── test_outline_schema.py    # 新：Outline schema + submit 捕获
└── test_outline_node.py      # 新：fake 模型 → 读 read 产 outline
```

---

## Interfaces

- Consumes：`state['read']`（spec107 `ReadResult.model_dump()`）；`build_create_agent`（spec105）。
- Produces：
  - `Outline`（Pydantic）：`chapters: list[OutlineChapter]`（含 tech/business）。
  - `make_outline_node(ctx) -> async (state)->{"outline": ...}`：替换 spec201 stub。

---

## Task 1: Outline schema（schemas.py）

**Files:** Modify `agents/bidding_agent/schemas.py`；Create `tests/agents/bidding_agent/test_outline_schema.py`

- [ ] **Step 1: 开分支**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout -b phase2/spec202-outline-node
```

- [ ] **Step 2: 在 `schemas.py` 末尾追加**

```python
class OutlineItem(BaseModel):
    id: str
    label: str                                  # 如 "1.1 项目背景与需求理解"
    clause_ids: list[str] = Field(default_factory=list)  # 招标依据条款 id（${secId}-cN，对齐原型 clauseIds）
    is_new: bool = False                         # 提纲新增（招标无直接来源）


class OutlineChapter(BaseModel):
    id: str                                      # t1..t5 / b1..b5
    no: str                                      # 第一章…
    title: str
    group: Literal["tech", "business"]
    sourced: bool = True                         # 能否在招标文件索引到来源
    items: list[OutlineItem] = Field(default_factory=list)


class Outline(BaseModel):
    chapters: list[OutlineChapter]

    @property
    def tech(self) -> list[OutlineChapter]:
        return [c for c in self.chapters if c.group == "tech"]

    @property
    def business(self) -> list[OutlineChapter]:
        return [c for c in self.chapters if c.group == "business"]
```

- [ ] **Step 3: 失败测试 `tests/agents/bidding_agent/test_outline_schema.py`**

```python
import asyncio
from agent.agents.bidding_agent.schemas import Outline
from agent.framework.structured import make_submit_tool


_SAMPLE = {"chapters": [
    {"id": "t1", "no": "第一章", "title": "项目理解与整体方案", "group": "tech", "sourced": True,
     "items": [{"id": "t1-1", "label": "1.1 项目背景与需求理解", "clause_ids": ["sec-technical-c1"]},
               {"id": "t1-3", "label": "1.3 方案亮点与服务承诺", "is_new": True}]},
    {"id": "b3", "no": "第三章", "title": "商务报价与价格构成", "group": "business", "sourced": True,
     "items": [{"id": "b3-1", "label": "3.1 投标报价一览表"}]},
]}


def test_outline_groups():
    o = Outline(**_SAMPLE)
    assert [c.id for c in o.tech] == ["t1"] and [c.id for c in o.business] == ["b3"]
    assert o.tech[0].items[1].is_new is True


def test_submit_outline_captures():
    tool, get = make_submit_tool("submit_outline", Outline, "提交提纲")
    asyncio.run(tool.ainvoke(_SAMPLE))
    assert len(get().chapters) == 2
```

- [ ] **Step 4: 通过 + 提交**

Run: `cd services/agent && uv run pytest tests/agents/bidding_agent/test_outline_schema.py -q` → 2 passed
```bash
git add services/agent/src/agent/agents/bidding_agent/schemas.py services/agent/tests/agents/bidding_agent/test_outline_schema.py
git commit -m "feat(spec202): Outline schema(技术标/商务标提纲, 对齐原型)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: outline 节点（prompts/outline.py + nodes/outline.py）

**Files:** Create `agents/bidding_agent/prompts/outline.py`；Modify `agents/bidding_agent/nodes/outline.py`；Create `tests/agents/bidding_agent/test_outline_node.py`

- [ ] **Step 1: 写 `prompts/outline.py`**

```python
OUTLINE_SYSTEM_PROMPT = """你是资深投标方案架构师。基于读标结论，搭建技术标与商务标的提纲（章—节两级）。

输入：读标结论（六大分类、评分办法表、废标红线）已在用户消息中给出。
要求：
1. 分两组：technical（技术标）与 business（商务标），各 4–6 章，章号 t1.. / b1..。
2. 每章给 no（第N章）、title、group、sourced（能在招标文件找到来源=true；纯新增章=false）。
3. 每章 3 个左右子项 OutlineItem：id、label（如「1.1 …」）、clause_ids（招标依据条款 id，形如 sec-technical-c1，对齐读标结论里的 clause_ids，可空）、
   is_new（招标无直接来源的加分/补强项=true）。
4. 提纲必须覆盖评分办法表的每个得分点（尤其★不可偏离项），并把废标红线对应到具体章节。
5. 最后调用 submit_outline 一次性提交完整提纲。
"""
```

- [ ] **Step 2: 改 `nodes/outline.py`（stub → 真实）**

```python
from __future__ import annotations
import json
from agent.framework.structured import make_submit_tool
from agent.framework.create_agent import build_create_agent
from agent.agents.bidding_agent.schemas import Outline
from agent.agents.bidding_agent.prompts.outline import OUTLINE_SYSTEM_PROMPT


def make_outline_node(ctx):
    """读 state['read'] → 产 Outline → 写 state['outline']。"""
    async def outline_node(state):
        submit, get_result = make_submit_tool("submit_outline", Outline, "提交提纲")
        sub = build_create_agent(OUTLINE_SYSTEM_PROMPT, [submit], ctx)
        read = json.dumps(state.get("read", {}), ensure_ascii=False)
        await sub.ainvoke({"messages": [{"role": "user", "content": f"读标结论：\n{read}\n请据此产出提纲。"}]})
        result = get_result()
        return {"outline": result.model_dump() if result else {"chapters": []}}
    return outline_node
```

- [ ] **Step 3: 失败测试 `tests/agents/bidding_agent/test_outline_node.py`**

```python
import asyncio
from langchain_core.messages import AIMessage
from agent.agents.bidding_agent.nodes.outline import make_outline_node


_OUTLINE_ARGS = {"chapters": [
    {"id": "t1", "no": "第一章", "title": "项目理解与整体方案", "group": "tech", "sourced": True,
     "items": [{"id": "t1-1", "label": "1.1 需求理解"}]},
    {"id": "b1", "no": "第一章", "title": "投标函", "group": "business", "sourced": True,
     "items": [{"id": "b1-1", "label": "1.1 投标函"}]},
]}


class _OutlineChat:
    def __init__(self): self.n = 0
    def bind_tools(self, tools): return self
    async def ainvoke(self, messages):
        self.n += 1
        if self.n == 1:
            return AIMessage(content="", tool_calls=[{"name": "submit_outline", "args": _OUTLINE_ARGS, "id": "o1"}])
        return AIMessage(content="提纲完成")


class _GW:
    def get_chat(self, **kw): return _OutlineChat()


class _Ctx:
    gateway = _GW()
    def __getattr__(self, k): return None


def test_outline_node_reads_read_produces_outline():
    node = make_outline_node(_Ctx())
    out = asyncio.run(node({"read": {"risk_summary": ["缺 ISO27001"]}}))
    assert "outline" in out
    ids = [c["id"] for c in out["outline"]["chapters"]]
    assert ids == ["t1", "b1"]
```

- [ ] **Step 4: 通过 + 提交**

Run: `cd services/agent && uv run pytest tests/agents/bidding_agent/test_outline_node.py -q` → 1 passed
```bash
git add services/agent/src/agent/agents/bidding_agent/prompts/outline.py services/agent/src/agent/agents/bidding_agent/nodes/outline.py services/agent/tests/agents/bidding_agent/test_outline_node.py
git commit -m "feat(spec202): outline 节点(读标→提纲, create_agent + submit_outline)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 工作流串联回归 + 合并

- [ ] **Step 1: 回归 spec201 stepwise 测试**（outline 已非 stub，应仍续跑通过）

Run: `cd services/agent && uv run pytest tests/agents/bidding_agent/ -q` → 全 passed
> `test_run2_resumes_to_outline_stub` 里 outline 现产真实结构；断言 `"outline" in nodes` 仍成立。若断言依赖 `_stub` 字段，改为断言 `out["outline"]["chapters"]` 存在。

- [ ] **Step 2: 合并**

```bash
cd services/agent && uv run pytest -q && uv run ruff check src
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout main && git merge --no-ff phase2/spec202-outline-node -m "merge spec202: 提纲 outline 节点"
git push origin main
```

---

## 验收清单（spec202）

- [ ] `Outline` schema 对齐原型：chapters{id,no,title,group,sourced,items:OutlineItem{id,label,clause_ids,is_new}}。
- [ ] `make_outline_node` 读 `state['read']` → 产 `state['outline']`；fake 模型测试通过。
- [ ] 提纲覆盖评分点/★项/废标红线（提示词约束；真实冒烟时人核）。
- [ ] 串入 spec201 图后逐步推进仍通过；`pytest` + `ruff` 全绿。
