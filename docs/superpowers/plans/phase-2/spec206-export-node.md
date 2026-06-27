# spec206 · 完整标书导出 export 节点（docx，普通服务） 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 spec201 的 `export` stub 替换为真实节点：读 `state['outline']`（章节顺序/标题）+ `state['chapters']`（各章 HTML 正文）→ 渲染**完整标书 `.docx`**（封面 + 目录 + 技术标/商务标各章 + 签章位）→ 落 MinIO，key 写入 `state['artifacts']['docx']`。**普通服务节点（无 LLM、确定性）**。这是「出完整标书」的最后一步，与述标 PPT（spec205）并列为两类终产物。

**Architecture:** `make_export_node(ctx)` = 纯 Python；`render/docx.py` 用 **python-docx** 把每章 HTML 转 docx 段落（标题/段落/列表/表格的最小映射），按 outline 顺序拼装（技术标在前、商务标在后或按招标目录），加目录占位与签章页。无模型调用、不碰钱。

**Tech Stack:** `python-docx`、轻量 HTML 解析（`html.parser` 或 `beautifulsoup4`）、MinIO 客户端、pytest。

## 对齐说明

- 章节顺序与标题取自 `state['outline']`（spec202 `Outline`，技术标 t*/商务标 b*）；正文取自 `state['chapters']`（spec203，HTML）。
- HTML→docx 最小映射：`<h3>`→Heading、`<p>`→段落、`<ul><li>`→项目符号、`<table>`→表格。复杂样式后续加固。
- 缺正文的章（content 未生成）→ 输出「（本章正文待生成）」占位，不报错。

## Global Constraints

见 `spec200-index.md`。关键：只动 `agents/bidding_agent/`；export 是确定性节点、无 LLM、不碰钱；`.docx` 落 MinIO（bidsaas 桶）；TDD；先开分支。

---

## File Structure

```
services/agent/src/agent/agents/bidding_agent/
├── nodes/export.py           # 改：stub → 真实 make_export_node
└── render/
    └── docx.py               # 新：render_docx(outline, chapters, *, meta) -> bytes（python-docx）
services/agent/tests/agents/bidding_agent/
├── test_docx_render.py       # 新：render_docx 产合法 .docx，含章节标题/正文
└── test_export_node.py       # 新：export 节点落 artifacts['docx'] key
```

---

## Interfaces

- Consumes：`state['outline']`、`state['chapters']`、`state['read'].project_meta`；MinIO 写客户端（spec106 `storage`）。
- Produces：
  - `render_docx(outline: dict, chapters: dict, *, meta: dict) -> bytes`：完整标书 .docx 字节。
  - `make_export_node(ctx) -> async (state)->{"artifacts": {"docx": key}}`：替换 spec201 stub。

---

## Task 1: docx 渲染层（render/docx.py）

**Files:** Modify `pyproject.toml`（加 `python-docx`、`beautifulsoup4`）；Create `agents/bidding_agent/render/docx.py`、`tests/agents/bidding_agent/test_docx_render.py`

- [ ] **Step 1: 开分支 + 依赖**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout -b phase2/spec206-export-node
cd services/agent && uv add python-docx beautifulsoup4
```

- [ ] **Step 2: 写 `render/docx.py`**

```python
from __future__ import annotations
import io
from bs4 import BeautifulSoup
from docx import Document
from docx.shared import Pt


def _emit_html(doc: Document, html: str) -> None:
    """HTML 最小映射到 docx：h3→Heading2, p→段落, ul/li→项目符号, table→表格。"""
    soup = BeautifulSoup(html or "", "html.parser")
    for el in soup.children:
        name = getattr(el, "name", None)
        if name in ("h1", "h2", "h3", "h4"):
            doc.add_heading(el.get_text(strip=True), level=2)
        elif name == "p":
            doc.add_paragraph(el.get_text(strip=True))
        elif name == "ul":
            for li in el.find_all("li", recursive=False):
                doc.add_paragraph(li.get_text(strip=True), style="List Bullet")
        elif name == "table":
            rows = el.find_all("tr")
            if rows:
                cols = rows[0].find_all(["td", "th"])
                t = doc.add_table(rows=len(rows), cols=len(cols))
                for i, r in enumerate(rows):
                    for j, c in enumerate(r.find_all(["td", "th"])):
                        t.rows[i].cells[j].text = c.get_text(strip=True)
        elif el.get_text(strip=True):
            doc.add_paragraph(el.get_text(strip=True))


def render_docx(outline: dict, chapters: dict, *, meta: dict | None = None) -> bytes:
    """完整标书 .docx：封面 + 目录占位 + 按 outline 顺序各章正文 + 签章页。确定性，无 LLM。"""
    meta = meta or {}
    doc = Document()
    # 封面
    doc.add_heading(meta.get("name", "投标文件"), level=0)
    if meta.get("buyer"):
        doc.add_paragraph(f"采购人：{meta['buyer']}")
    if meta.get("code"):
        doc.add_paragraph(f"招标编号：{meta['code']}")
    doc.add_paragraph("投标人：____________________（盖章）")
    doc.add_page_break()
    # 目录占位
    doc.add_heading("目录", level=1)
    doc.add_paragraph("（请在 Word 中更新域以生成目录）")
    doc.add_page_break()
    # 章节正文：按 outline 顺序
    for ch in outline.get("chapters", []):
        group = "技术标" if ch.get("group") == "tech" else "商务标"
        doc.add_heading(f"{ch.get('no','')} {ch.get('title','')}（{group}）", level=1)
        body = chapters.get(ch.get("id", ""), "")
        if body:
            _emit_html(doc, body)
        else:
            doc.add_paragraph("（本章正文待生成）")
    # 签章页
    doc.add_page_break()
    doc.add_heading("投标人承诺与签章", level=1)
    doc.add_paragraph("法定代表人/授权代表（签字）：____________   日期：__________")
    out = io.BytesIO()
    doc.save(out)
    return out.getvalue()
```

- [ ] **Step 3: 失败测试 `tests/agents/bidding_agent/test_docx_render.py`**

```python
import io
from docx import Document
from agent.agents.bidding_agent.render.docx import render_docx


def test_render_docx_assembles_chapters():
    outline = {"chapters": [
        {"id": "t1", "no": "第一章", "title": "项目理解", "group": "tech"},
        {"id": "b3", "no": "第三章", "title": "商务报价", "group": "business"},
        {"id": "t5", "no": "第五章", "title": "应急预案", "group": "tech"},  # 无正文 → 占位
    ]}
    chapters = {"t1": "<h3>1.1 需求理解</h3><p>政务云运维…</p><ul><li>7×24</li></ul>",
                "b3": "<h3>3.1 报价</h3><p>1560 万元</p>"}
    data = render_docx(outline, chapters, meta={"name": "某市政务云运维 投标文件", "buyer": "某市大数据局"})
    assert data[:2] == b"PK"
    doc = Document(io.BytesIO(data))
    texts = "\n".join(p.text for p in doc.paragraphs)
    assert "某市政务云运维 投标文件" in texts
    assert "（本章正文待生成）" in texts          # t5 无正文 → 占位
    assert "7×24" in texts                         # 列表项进入 docx
```

- [ ] **Step 4: 通过 + 提交**

Run: `cd services/agent && uv run pytest tests/agents/bidding_agent/test_docx_render.py -q` → passed
```bash
git add services/agent/pyproject.toml services/agent/uv.lock services/agent/src/agent/agents/bidding_agent/render/docx.py services/agent/tests/agents/bidding_agent/test_docx_render.py
git commit -m "feat(spec206): docx 渲染层 render_docx(python-docx, HTML→docx)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: export 节点（落 MinIO）

**Files:** Modify `agents/bidding_agent/nodes/export.py`；Create `tests/agents/bidding_agent/test_export_node.py`

- [ ] **Step 1: 改 `nodes/export.py`（stub → 真实）**

```python
from __future__ import annotations
from agent.agents.bidding_agent.render.docx import render_docx
from agent.parsing.storage_read import storage          # spec106 MinIO 封装


def make_export_node(ctx):
    """读 outline+chapters → 渲染完整标书 .docx → 落 MinIO → 写 artifacts['docx']。普通服务，无 LLM。"""
    async def export_node(state):
        meta = (state.get("read", {}) or {}).get("project_meta", {})
        data = render_docx(state.get("outline", {}), state.get("chapters", {}), meta=meta)
        key = f"artifacts/{ctx.thread_id}/bid.docx"
        await storage.put_bytes(key, data,
                                content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        # 合并而非覆盖 artifacts（present 可能已写 pptx）——由 spec201 state.py 的 artifacts 合并 reducer 保证
        return {"artifacts": {"docx": key}}
    return export_node
```

> `state['artifacts']` 的合并：present（pptx）与 export（docx）都写 `artifacts`。合并语义由 **spec201 的 `BiddingState.artifacts` 合并 reducer（`Annotated[dict, _merge_dict]`，已在 spec201 state.py 定义一次）** 保证；**本 spec 不再改 state、不重复定义 reducer**。

- [ ] **Step 2: 失败测试 `tests/agents/bidding_agent/test_export_node.py`**

```python
import asyncio
from agent.agents.bidding_agent.nodes import export as export_mod
from agent.agents.bidding_agent.nodes.export import make_export_node


class _Ctx:
    thread_id = "proj-7"
    def __getattr__(self, k): return None


def test_export_node_writes_docx_key(monkeypatch):
    saved = {}

    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            saved["key"], saved["len"], saved["ct"] = key, len(data), content_type

    monkeypatch.setattr(export_mod, "storage", _Storage())
    node = make_export_node(_Ctx())
    out = asyncio.run(node({
        "outline": {"chapters": [{"id": "t1", "no": "第一章", "title": "项目理解", "group": "tech"}]},
        "chapters": {"t1": "<h3>1.1</h3><p>正文</p>"},
        "read": {"project_meta": {"name": "投标文件"}},
    }))
    assert out["artifacts"]["docx"] == "artifacts/proj-7/bid.docx"
    assert saved["len"] > 0 and "wordprocessingml" in saved["ct"]
```

- [ ] **Step 3: 通过 + 提交**

Run: `cd services/agent && uv run pytest tests/agents/bidding_agent/test_export_node.py -q` → passed
```bash
git add services/agent/src/agent/agents/bidding_agent/nodes/export.py services/agent/tests/agents/bidding_agent/test_export_node.py
git commit -m "feat(spec206): export 节点(完整标书 .docx 落 MinIO)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 依赖 spec201 artifacts reducer + 串联回归 + 合并

**Files:**（无新增；**本 spec 不改 state.py**）

- [ ] **Step 1: 依赖 spec201 已定义的 artifacts 合并 reducer（不重复定义）**

`state['artifacts']` 的合并 reducer（`_merge_dict`，`Annotated[dict[str, str], _merge_dict]`）**已在 spec201 的 state.py 定义一次**，本 spec **不再改 state、不重复加 reducer**。export_node 只返回增量 `{"docx": key}`，与 present 的 `{"pptx": key}` 由该 reducer 合并并存。

> 串联回归时确认：present 步与 export 步分别写入后，`state['artifacts']` 中 pptx/docx 并存、互不覆盖。

- [ ] **Step 2: 回归** `cd services/agent && uv run pytest tests/agents/bidding_agent/ -q && uv run ruff check src` → 全 passed
- [ ] **Step 3: 合并**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout main && git merge --no-ff phase2/spec206-export-node -m "merge spec206: 完整标书导出 export 节点(docx)"
git push origin main
```

---

## 验收清单（spec206）

- [ ] `render_docx` 用 python-docx 按 outline 顺序拼章、HTML→docx 最小映射、缺正文出占位；产合法 `.docx`。
- [ ] 封面（项目名/采购人/编号）+ 目录占位 + 技术标/商务标各章 + 签章页齐全。
- [ ] `make_export_node` 落 `.docx` 到 MinIO，key 入 `state['artifacts']['docx']`。
- [ ] 依赖 spec201 的 `artifacts` 合并 reducer（本 spec 不改 state、不重复定义）：pptx 与 docx 并存不互相覆盖。
- [ ] 串入 spec201 图通过；`pytest`+`ruff` 全绿。
