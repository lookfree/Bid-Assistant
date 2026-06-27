# spec204 · 审查 review 节点（废标体检 + 查重） 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 spec201 的 `review` stub 替换为真实节点：拿**招标要求（`state['read']` 的废标红线/★项/评分点）** 与 **投标内容（`state['outline']` + `state['chapters']`）** 比对 → 产出 `RiskReport`（总分 + 高/中风险项 + 通过项 + 每条定位到标书章节），并做**查重**（章节间/疑似套话重复）。结构逐字对齐 C 端 `/risk`（`sample-bid.ts: riskFindings`）。create_agent 式（要可解释、流程别飘）。

**Architecture:** `make_review_node(ctx)` 用 `build_create_agent` 跑一个挂 `submit_risk_report(RiskReport)` 的子 agent；系统提示喂入读标红线 + 标书章节正文，逐条核对（缺★资格=高风险/废标、实质性要求未响应=中风险、业绩举证薄=中风险…），每条给 `advice` 与 `target_tab/target_id` 定位。查重作为一项检查并入（章节文本相似度过高 → 提示）。

**Tech Stack:** spec105（create_agent + make_submit_tool）、spec201 图、Pydantic、pytest。

## 前端交互对齐（依据 C 端原型 `/risk`）

- 顶部体检分 `score`（如 78）+ 计数：`high`(高风险) / `mid`(中风险) / `passed`(通过项数)。
- 风险项 `RiskFinding`：`level`(高风险/中风险)、`tone`(destructive/warning)、`title`、`chapterTitle`(对应标书章节)、`tenderRef`("对应：第X章…★…")、`advice`(整改建议)、`targetTab`(tech/business) + `targetId`(章节 id，点击定位)。
- 通过项 `passedItems: string[]`（已满足的合规点清单）。
- 高风险示例（原型）：缺 ISO27001（强制资格→废标）；中风险：未明确分级 SLA、业绩举证不足。

## Global Constraints

见 `spec200-index.md`。关键：只动 `agents/bidding_agent/`；读 read+outline+chapters 产 risk；可解释、忠于招标原文、不漏★不可偏离与废标红线；TDD；先开分支。

---

## File Structure

```
services/agent/src/agent/agents/bidding_agent/
├── schemas.py                # 改：加 RiskFinding / RiskReport
├── prompts/review.py         # 新：REVIEW_SYSTEM_PROMPT
└── nodes/review.py           # 改：stub → 真实 make_review_node
services/agent/tests/agents/bidding_agent/
├── test_review_schema.py     # 新：RiskReport schema + submit 捕获
└── test_review_node.py       # 新：fake 模型 → 缺 ISO27001 命中高风险
```

---

## Interfaces

- Consumes：`state['read']`、`state['outline']`、`state['chapters']`；`build_create_agent`（spec105）。
- Produces：
  - `RiskFinding` / `RiskReport`（Pydantic，对齐 `riskFindings`）。
  - `make_review_node(ctx) -> async (state)->{"risk": RiskReport.model_dump()}`：替换 spec201 stub。

---

## Task 1: RiskReport schema（schemas.py）

**Files:** Modify `agents/bidding_agent/schemas.py`；Create `tests/agents/bidding_agent/test_review_schema.py`

- [ ] **Step 1: 开分支**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout -b phase2/spec204-review-node
```

- [ ] **Step 2: `schemas.py` 末尾追加**

```python
class RiskFinding(BaseModel):
    level: str                                    # 高风险 / 中风险
    tone: Literal["destructive", "warning"]
    title: str
    chapter_title: str = ""                       # 对应标书章节标题
    tender_ref: str = ""                          # 对应招标条款（"对应：第X章…★…"）
    advice: str = ""                              # 整改建议
    target_tab: Literal["tech", "business"]
    target_id: str                                # 章节 id（点击定位）


class RiskReport(BaseModel):
    score: int                                    # 体检分 0–100
    high: int = 0                                 # 高风险数
    mid: int = 0                                  # 中风险数
    passed: int = 0                               # 通过项数
    items: list[RiskFinding] = Field(default_factory=list)
    passed_items: list[str] = Field(default_factory=list)
```

- [ ] **Step 3: 失败测试 `tests/agents/bidding_agent/test_review_schema.py`**

```python
import asyncio
from agent.agents.bidding_agent.schemas import RiskReport
from agent.framework.structured import make_submit_tool


_SAMPLE = {
    "score": 78, "high": 1, "mid": 2, "passed": 9,
    "items": [{"level": "高风险", "tone": "destructive", "title": "缺少 ISO27001 认证",
               "chapter_title": "企业资质与信誉证明", "tender_ref": "对应：第二章 资格要求（★不可偏离）",
               "advice": "补 ISO27001 证书并附商务标第四章，否则废标", "target_tab": "business", "target_id": "b4"}],
    "passed_items": ["投标报价未超最高限价", "投标函格式与签章合规"],
}


def test_risk_report_validates():
    r = RiskReport(**_SAMPLE)
    assert r.high == 1 and r.items[0].target_id == "b4" and r.items[0].tone == "destructive"


def test_submit_risk_captures():
    tool, get = make_submit_tool("submit_risk_report", RiskReport, "提交审查报告")
    asyncio.run(tool.ainvoke(_SAMPLE))
    assert get().score == 78 and len(get().passed_items) == 2
```

- [ ] **Step 4: 通过 + 提交**

Run: `cd services/agent && uv run pytest tests/agents/bidding_agent/test_review_schema.py -q` → 2 passed
```bash
git add services/agent/src/agent/agents/bidding_agent/schemas.py services/agent/tests/agents/bidding_agent/test_review_schema.py
git commit -m "feat(spec204): RiskReport schema(废标体检, 对齐原型 riskFindings)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: review 节点（prompts/review.py + nodes/review.py）

**Files:** Create `agents/bidding_agent/prompts/review.py`；Modify `agents/bidding_agent/nodes/review.py`；Create `tests/agents/bidding_agent/test_review_node.py`

- [ ] **Step 1: 写 `prompts/review.py`**

```python
REVIEW_SYSTEM_PROMPT = """你是投标合规审查专家（废标体检）。把投标文件与招标要求逐条比对，给出风险体检报告。

输入：读标结论（含废标红线/★不可偏离/评分点）、提纲、各章正文，均在用户消息中。
检查要点：
1. ★不可偏离 / 强制资格：缺失或未响应 → 高风险（tone=destructive，多为废标项），写明对应招标条款与整改建议。
2. 实质性要求未明确承诺（如分级 SLA、服务期、保证金）→ 中风险（tone=warning）。
3. 业绩/资质举证不足、价格构成缺失 → 中风险。
4. 查重：章节间是否大段重复/套话堆砌 → 中风险提示。
5. 已满足项归入 passed_items。
对每条风险给 chapter_title、tender_ref（"对应：…"）、advice、target_tab(tech/business)、target_id(章id)。
给体检分 score（0–100）与 high/mid/passed 计数。最后调用 submit_risk_report 一次性提交。
忠于招标原文，不放过废标红线，也不虚构风险。
"""
```

- [ ] **Step 2: 改 `nodes/review.py`（stub → 真实）**

```python
from __future__ import annotations
import json
from agent.framework.structured import make_submit_tool
from agent.framework.create_agent import build_create_agent
from agent.agents.bidding_agent.schemas import RiskReport
from agent.agents.bidding_agent.prompts.review import REVIEW_SYSTEM_PROMPT


def make_review_node(ctx):
    """读 read+outline+chapters → 产 RiskReport → 写 state['risk']。"""
    async def review_node(state):
        submit, get_result = make_submit_tool("submit_risk_report", RiskReport, "提交审查报告")
        sub = build_create_agent(REVIEW_SYSTEM_PROMPT, [submit], ctx)
        payload = {"read": state.get("read", {}), "outline": state.get("outline", {}),
                   "chapters": state.get("chapters", {})}
        user = "招标与投标材料：\n" + json.dumps(payload, ensure_ascii=False) + "\n请审查并提交体检报告。"
        await sub.ainvoke({"messages": [{"role": "user", "content": user}]})
        result = get_result()
        return {"risk": result.model_dump() if result else {"score": 0, "items": []}}
    return review_node
```

- [ ] **Step 3: 失败测试 `tests/agents/bidding_agent/test_review_node.py`**

```python
import asyncio
from langchain_core.messages import AIMessage
from agent.agents.bidding_agent.nodes.review import make_review_node


_RISK_ARGS = {
    "score": 78, "high": 1, "mid": 0, "passed": 5,
    "items": [{"level": "高风险", "tone": "destructive", "title": "缺少 ISO27001 认证",
               "chapter_title": "企业资质与信誉证明", "tender_ref": "对应：第二章 资格要求（★）",
               "advice": "补证书否则废标", "target_tab": "business", "target_id": "b4"}],
    "passed_items": ["报价未超限价"],
}


class _ReviewChat:
    def __init__(self): self.n = 0
    def bind_tools(self, tools): return self
    async def ainvoke(self, messages):
        self.n += 1
        if self.n == 1:
            return AIMessage(content="", tool_calls=[{"name": "submit_risk_report", "args": _RISK_ARGS, "id": "v1"}])
        return AIMessage(content="审查完成")


class _GW:
    def get_chat(self, **kw): return _ReviewChat()


class _Ctx:
    gateway = _GW()
    def __getattr__(self, k): return None


def test_review_node_flags_iso_high_risk():
    node = make_review_node(_Ctx())
    out = asyncio.run(node({
        "read": {"risk_summary": ["缺 ISO27001 即废标"]},
        "chapters": {"b4": "<h3>4.1 营业执照与体系认证</h3><p>已通过 ISO9001…</p>"},
    }))
    risk = out["risk"]
    assert risk["high"] == 1
    assert risk["items"][0]["target_id"] == "b4" and risk["items"][0]["tone"] == "destructive"
```

- [ ] **Step 4: 通过 + 提交**

Run: `cd services/agent && uv run pytest tests/agents/bidding_agent/test_review_node.py -q` → 1 passed
```bash
git add services/agent/src/agent/agents/bidding_agent/prompts/review.py services/agent/src/agent/agents/bidding_agent/nodes/review.py services/agent/tests/agents/bidding_agent/test_review_node.py
git commit -m "feat(spec204): review 节点(废标体检+查重, create_agent + submit_risk_report)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 串联回归 + 合并

- [ ] **Step 1: 回归** `cd services/agent && uv run pytest tests/agents/bidding_agent/ -q && uv run ruff check src` → 全 passed
- [ ] **Step 2: 合并**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout main && git merge --no-ff phase2/spec204-review-node -m "merge spec204: 审查 review 节点(废标体检+查重)"
git push origin main
```

---

## 验收清单（spec204）

- [ ] `RiskReport` 对齐原型：score + high/mid/passed + items:RiskFinding{level,tone,title,chapter_title,tender_ref,advice,target_tab,target_id} + passed_items。
- [ ] `make_review_node` 读 read+outline+chapters → 产 `state['risk']`；缺★资格命中高风险（fake 测试覆盖）。
- [ ] 含查重检查项；每条风险可定位到标书章节（target_tab/target_id）。
- [ ] 串入 spec201 图逐步推进通过；`pytest`+`ruff` 全绿。
