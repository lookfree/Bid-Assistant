# spec205 · 述标 present 节点 + PPT 渲染 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 spec201 的 `present` stub 替换为真实节点，并加 **PPT 渲染层**：读 `state['chapters']` + `state['read']`（评分点）→ 用 `submit_deck` 产出 `DeckSpec`（讲标大纲 + 每页要点 + 口播稿 + 问答预演）写入 `state['deck']` →「渲染层」`render/pptx.py` 用 **python-pptx** 出 `.pptx` 上传 MinIO，key 写入 `state['artifacts']['pptx']`。**两段式（§4.2.1）：智能体只产结构化 `DeckSpec`，渲染是确定性代码、不碰钱。** 结构逐字对齐 C 端 `/present`（`present.ts: Slide/QA/buildDeck/slideStyles`）。

**Architecture:** present 节点 = `create_agent` + `submit_deck`（产稿）；`render/pptx.py` = 纯 Python（非 LLM）把 `DeckSpec` 画成 `.pptx`。时长档 `duration ∈ {10,15,20}` 控制页数/要点密度；模板 `template`（商务蓝/科技感/政务红）映射到母版样式。节点产 DeckSpec 后调用渲染层落 `.pptx` 到 MinIO（复用 spec106 的存储客户端写回）。

**Tech Stack:** spec105（create_agent + make_submit_tool）、`python-pptx`、MinIO 客户端（spec006/spec106）、Pydantic、pytest。

## 前端交互对齐（依据 C 端原型 `/present`）

- `Slide`：`{ id, title, scoring?(本页对应评分点), bullets: string[](要点), notes(口播稿/讲稿), kind: "cover"|"content"|"end" }`。
- `QA`：`{ q, a }`（评委问答预演）。
- `buildDeck(minutes)`：`minutes ∈ {10,15,20}` → 不同页数/要点密度（10≈精简、20≈完整）。
- 模板样式：`template ∈ {blue 商务蓝, tech 科技感, gov 政务红}`（对齐原型 `slideStyles` 的 `StyleId`）+ 企业自有模板 `enterprise_template_id`（如 pe1/pe2，对齐 `enterpriseTemplateStyles`）。
- 封面页（cover）含项目名/投标人；结束页（end）致谢。

## Global Constraints

见 `spec200-index.md`。关键：只动 `agents/bidding_agent/`；**两段式**——智能体产 `DeckSpec`、渲染确定性归 Python 侧（python-pptx）；不碰钱；`.pptx` 落 MinIO（bidsaas 桶）；TDD；先开分支。

---

## File Structure

```
services/agent/src/agent/agents/bidding_agent/
├── schemas.py                # 改：加 Slide / QA / DeckSpec
├── prompts/present.py        # 新：PRESENT_SYSTEM_PROMPT
├── nodes/present.py          # 改：stub → 真实 make_present_node（产 DeckSpec + 调渲染）
└── render/
    ├── __init__.py           # 新
    └── pptx.py               # 新：render_pptx(deck, *, template) -> bytes（python-pptx）
services/agent/tests/agents/bidding_agent/
├── test_deck_schema.py       # 新：DeckSpec schema + submit 捕获
├── test_present_node.py      # 新：fake 模型 → DeckSpec + 渲染桩落 key
└── test_pptx_render.py       # 新：render_pptx 产出非空 .pptx（真 python-pptx）
```

---

## Interfaces

- Consumes：`state['chapters']`、`state['read']`；`build_create_agent`（spec105）；MinIO 写客户端（spec106 `storage`）。
- Produces：
  - `Slide` / `QA` / `DeckSpec`（Pydantic，对齐 `present.ts`）。
  - `render_pptx(deck: DeckSpec, *, template: str = "blue") -> bytes`：DeckSpec → .pptx 字节。
  - `make_present_node(ctx) -> async (state)->{"deck": ..., "artifacts": {"pptx": key}}`：替换 spec201 stub。

---

## Task 1: DeckSpec schema（schemas.py）

**Files:** Modify `agents/bidding_agent/schemas.py`；Create `tests/agents/bidding_agent/test_deck_schema.py`

- [ ] **Step 1: 开分支**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout -b phase2/spec205-present-node
```

- [ ] **Step 2: `schemas.py` 末尾追加**

```python
class Slide(BaseModel):
    id: str
    title: str
    scoring: str = ""                              # 本页对应评分点（可空）
    bullets: list[str] = Field(default_factory=list)
    notes: str = ""                                # 口播稿/讲稿
    kind: Literal["cover", "content", "end"] = "content"


class QA(BaseModel):
    q: str
    a: str


class DeckSpec(BaseModel):
    title: str = ""                                # 述标主题（项目名）
    duration: Literal[10, 15, 20] = 15             # 讲标时长档（分钟）
    template: Literal["blue", "tech", "gov"] = "blue"  # 对齐原型 StyleId（商务蓝/科技感/政务红）
    enterprise_template_id: str | None = None      # 企业自有模板（如 pe1/pe2），优先于 template
    slides: list[Slide]
    qa: list[QA] = Field(default_factory=list)
```

- [ ] **Step 3: 失败测试 `tests/agents/bidding_agent/test_deck_schema.py`**

```python
import asyncio
from agent.agents.bidding_agent.schemas import DeckSpec
from agent.framework.structured import make_submit_tool


_SAMPLE = {
    "title": "某市政务云运维 述标", "duration": 15, "template": "gov",
    "slides": [
        {"id": "s0", "title": "封面", "kind": "cover", "bullets": []},
        {"id": "s1", "title": "运维服务体系", "scoring": "技术方案 50 分",
         "bullets": ["7×24 值守", "分级 SLA"], "notes": "各位评委，我方运维体系…", "kind": "content"},
        {"id": "s9", "title": "致谢", "kind": "end", "bullets": []},
    ],
    "qa": [{"q": "如何保障 99.9% 可用性？", "a": "统一监控+分级响应+主动巡检…"}],
}


def test_deck_validates():
    d = DeckSpec(**_SAMPLE)
    assert d.duration == 15 and d.slides[0].kind == "cover" and d.qa[0].q.endswith("？")


def test_submit_deck_captures():
    tool, get = make_submit_tool("submit_deck", DeckSpec, "提交述标 DeckSpec")
    asyncio.run(tool.ainvoke(_SAMPLE))
    assert len(get().slides) == 3 and get().template == "gov"
```

- [ ] **Step 4: 通过 + 提交**

Run: `cd services/agent && uv run pytest tests/agents/bidding_agent/test_deck_schema.py -q` → 2 passed
```bash
git add services/agent/src/agent/agents/bidding_agent/schemas.py services/agent/tests/agents/bidding_agent/test_deck_schema.py
git commit -m "feat(spec205): DeckSpec schema(述标稿, 对齐原型 present.ts)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: PPT 渲染层（render/pptx.py，python-pptx，确定性）

**Files:** Modify `pyproject.toml`（加 `python-pptx`）；Create `agents/bidding_agent/render/__init__.py`、`render/pptx.py`、`tests/agents/bidding_agent/test_pptx_render.py`

- [ ] **Step 1: 加依赖**

```bash
cd services/agent && uv add python-pptx
```

- [ ] **Step 2: 写 `render/pptx.py`**

```python
from __future__ import annotations
import io
from pptx import Presentation
from pptx.util import Pt
from agent.agents.bidding_agent.schemas import DeckSpec

# 模板 → 主色（RGB），简化映射；企业自有母版后续可加载 .pptx 模板文件
_TEMPLATE_RGB = {"blue": (0x1F, 0x4E, 0x79), "tech": (0x0E, 0x76, 0x90), "gov": (0xA8, 0x1E, 0x1E)}


def render_pptx(deck: DeckSpec, *, template: str | None = None) -> bytes:
    """DeckSpec → .pptx 字节（确定性，无 LLM）。封面/正文/结束页 + 备注放口播稿。"""
    prs = Presentation()
    blank, title_only = prs.slide_layouts[6], prs.slide_layouts[5]
    for s in deck.slides:
        slide = prs.slides.add_slide(title_only if s.kind != "content" else blank)
        # 标题
        if slide.shapes.title is not None:
            slide.shapes.title.text = s.title
        else:
            tb = slide.shapes.add_textbox(Pt(40), Pt(30), Pt(640), Pt(60))
            tb.text_frame.text = s.title
        # 要点
        if s.bullets:
            body = slide.shapes.add_textbox(Pt(40), Pt(110), Pt(640), Pt(360)).text_frame
            body.text = s.bullets[0]
            for b in s.bullets[1:]:
                body.add_paragraph().text = b
        # 评分点角标
        if s.scoring:
            note = slide.shapes.add_textbox(Pt(40), Pt(480), Pt(640), Pt(30)).text_frame
            note.text = f"评分点：{s.scoring}"
        # 口播稿 → 备注页
        if s.notes:
            slide.notes_slide.notes_text_frame.text = s.notes
    out = io.BytesIO()
    prs.save(out)
    return out.getvalue()
```

> 模板色/企业母版为加固项；本 spec 先保证「DeckSpec → 合法 .pptx + 备注含口播稿」。`_TEMPLATE_RGB` 预留上色钩子。

- [ ] **Step 3: 失败测试 `tests/agents/bidding_agent/test_pptx_render.py`**

```python
from pptx import Presentation
import io
from agent.agents.bidding_agent.schemas import DeckSpec
from agent.agents.bidding_agent.render.pptx import render_pptx


def test_render_pptx_produces_valid_deck():
    deck = DeckSpec(title="述标", slides=[
        {"id": "s0", "title": "封面", "kind": "cover"},
        {"id": "s1", "title": "运维体系", "bullets": ["7×24", "分级 SLA"], "notes": "讲稿…", "kind": "content"},
    ])
    data = render_pptx(deck)
    assert data[:2] == b"PK"                       # .pptx 是 zip
    prs = Presentation(io.BytesIO(data))
    assert len(prs.slides) == 2
    assert prs.slides[1].notes_slide.notes_text_frame.text == "讲稿…"
```

- [ ] **Step 4: 通过 + 提交**

Run: `cd services/agent && uv run pytest tests/agents/bidding_agent/test_pptx_render.py -q` → passed
```bash
git add services/agent/pyproject.toml services/agent/src/agent/agents/bidding_agent/render tests/agents/bidding_agent/test_pptx_render.py 2>/dev/null; \
git add services/agent/pyproject.toml services/agent/uv.lock services/agent/src/agent/agents/bidding_agent/render services/agent/tests/agents/bidding_agent/test_pptx_render.py
git commit -m "feat(spec205): PPT 渲染层 render_pptx(python-pptx, 确定性)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: present 节点（产 DeckSpec + 调渲染落 MinIO）

**Files:** Create `agents/bidding_agent/prompts/present.py`；Modify `agents/bidding_agent/nodes/present.py`；Create `tests/agents/bidding_agent/test_present_node.py`

- [ ] **Step 1: 写 `prompts/present.py`**

```python
PRESENT_SYSTEM_PROMPT = """你是述标演示专家。基于标书正文与评分点，产出述标 PPT 的结构化脚本 DeckSpec。

输入：各章正文摘要、评分办法（评分点）、时长档（分钟）已在用户消息给出。
要求：
1. 首页 kind=cover（项目名/投标人），末页 kind=end（致谢），中间 kind=content。
2. 每张 content 页：title、scoring（本页对应评分点）、bullets（3–5 条要点）、notes（这页的口播稿，自然口语、可照读）。
3. 紧扣评分点与★项；按时长档控制页数：10 分钟≈8–10 页、15≈12–15 页、20≈16–20 页。
4. 附 3–6 条评委问答预演 qa（q/a）。
5. 选择合适 template（blue 商务蓝 / tech 科技感 / gov 政务红）；若客户指定企业自有模板则置 enterprise_template_id（如 pe1/pe2）。最后调用 submit_deck 一次性提交。
"""
```

- [ ] **Step 2: 改 `nodes/present.py`（stub → 真实）**

```python
from __future__ import annotations
import json
from agent.framework.structured import make_submit_tool
from agent.framework.create_agent import build_create_agent
from agent.agents.bidding_agent.schemas import DeckSpec
from agent.agents.bidding_agent.prompts.present import PRESENT_SYSTEM_PROMPT
from agent.agents.bidding_agent.render.pptx import render_pptx
from agent.parsing.storage_read import storage          # spec106 暴露的 MinIO 客户端（读写同一封装）


def make_present_node(ctx, *, duration: int = 15):
    """读 chapters+read → 产 DeckSpec → 渲染 .pptx 落 MinIO → 写 state['deck'] / artifacts['pptx']。"""
    async def present_node(state):
        submit, get_result = make_submit_tool("submit_deck", DeckSpec, "提交述标 DeckSpec")
        sub = build_create_agent(PRESENT_SYSTEM_PROMPT, [submit], ctx)
        payload = {"chapters": state.get("chapters", {}), "read": state.get("read", {}), "duration": duration}
        await sub.ainvoke({"messages": [{"role": "user",
            "content": "标书与评分点：\n" + json.dumps(payload, ensure_ascii=False) + f"\n时长 {duration} 分钟，请产 DeckSpec。"}]})
        deck = get_result()
        if deck is None:
            return {"deck": {}}
        data = render_pptx(deck, template=deck.template)
        key = f"artifacts/{ctx.thread_id}/present.pptx"
        await storage.put_bytes(key, data,
                                content_type="application/vnd.openxmlformats-officedocument.presentationml.presentation")
        return {"deck": deck.model_dump(), "artifacts": {"pptx": key}}
    return present_node
```

> `storage.put_bytes(key, data, content_type=...)` 为 MinIO 写封装；若 spec106 暴露名不同（如 `storage_write`），按实际调整。`make_present_node` 接 graph 时 spec201 的 `make_present_node(ctx)` 调用签名不变（duration 走默认/可由 state 传）。

- [ ] **Step 3: 失败测试 `tests/agents/bidding_agent/test_present_node.py`**

```python
import asyncio
from langchain_core.messages import AIMessage
from agent.agents.bidding_agent.nodes import present as present_mod
from agent.agents.bidding_agent.nodes.present import make_present_node


_DECK_ARGS = {"title": "述标", "duration": 15, "template": "gov", "slides": [
    {"id": "s0", "title": "封面", "kind": "cover"},
    {"id": "s1", "title": "运维体系", "bullets": ["7×24"], "notes": "讲稿", "kind": "content"},
], "qa": [{"q": "可用性？", "a": "99.9%"}]}


class _DeckChat:
    def __init__(self): self.n = 0
    def bind_tools(self, tools): return self
    async def ainvoke(self, messages):
        self.n += 1
        if self.n == 1:
            return AIMessage(content="", tool_calls=[{"name": "submit_deck", "args": _DECK_ARGS, "id": "d1"}])
        return AIMessage(content="述标稿完成")


class _GW:
    def get_chat(self, **kw): return _DeckChat()


class _Ctx:
    gateway = _GW(); thread_id = "proj-1"
    def __getattr__(self, k): return None


def test_present_node_produces_deck_and_pptx_key(monkeypatch):
    saved = {}

    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            saved["key"], saved["len"] = key, len(data)

    monkeypatch.setattr(present_mod, "storage", _Storage())
    node = make_present_node(_Ctx())
    out = asyncio.run(node({"chapters": {"t3": "<h3>SLA</h3>"}, "read": {}}))
    assert out["deck"]["template"] == "gov"
    assert out["artifacts"]["pptx"] == "artifacts/proj-1/present.pptx"
    assert saved["len"] > 0                          # 真渲染了 .pptx 字节
```

- [ ] **Step 4: 通过 + 提交**

Run: `cd services/agent && uv run pytest tests/agents/bidding_agent/test_present_node.py -q` → passed
```bash
git add services/agent/src/agent/agents/bidding_agent/prompts/present.py services/agent/src/agent/agents/bidding_agent/nodes/present.py services/agent/tests/agents/bidding_agent/test_present_node.py
git commit -m "feat(spec205): present 节点(产 DeckSpec + python-pptx 渲染落 MinIO)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 串联回归 + 真实冒烟 + 合并

- [ ] **Step 1: 回归** `cd services/agent && uv run pytest tests/agents/bidding_agent/ -q && uv run ruff check src` → 全 passed
- [ ] **Step 2: 真实冒烟（配 Key）**：走 present 节点 → 下载 `artifacts/<thread>/present.pptx` 用 PowerPoint/WPS 打开，页数/口播稿/问答齐全。
- [ ] **Step 3: 合并**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout main && git merge --no-ff phase2/spec205-present-node -m "merge spec205: 述标 present 节点 + PPT 渲染"
git push origin main
```

---

## 验收清单（spec205）

- [ ] `DeckSpec` 对齐原型：slides:Slide{id,title,scoring,bullets,notes,kind:cover|content|end} + qa:QA{q,a} + duration(10/15/20) + template(blue/tech/gov) + enterprise_template_id。
- [ ] `render_pptx` 用 python-pptx 产合法 `.pptx`，口播稿落备注页（真渲染测试）。
- [ ] `make_present_node` 产 DeckSpec → 渲染 → `.pptx` 落 MinIO，key 入 `state['artifacts']['pptx']`。
- [ ] 两段式不破：智能体只产 DeckSpec + 渲染确定性；不碰钱。
- [ ] 串入 spec201 图通过；`pytest`+`ruff` 全绿；真实 `.pptx` 可打开（配 Key 冒烟）。
