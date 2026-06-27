# spec203 · 正文 content 节点（deepagent，★最大） 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 spec201 的 `content` stub 替换为真实节点：读 `state['outline']` + `state['read']` → **按章生成商务标/技术标正文**（HTML），写入 `state['chapters'] = {chapter_id: body_html}`。这是**唯一用 deepagent 的节点**：主 agent 规划章节（todos）→ **子agent 按章并行写** → 虚拟 FS 暂存每章草稿 → 汇总。另提供**章节级「AI 对话改写」**（针对单章 + 用户指令重写）。配**上下文压缩节点**（长标书必需）。结构对齐 C 端 `/content`（三栏：提纲树 / 正文 / 章节 AI 对话），正文风格对齐原型 `chapters[].body`。

**Architecture:** `make_content_node(ctx)` 返回一个图节点，内部跑一个 `DeepAgent`（spec105 的 deepagent 式支持：动态规划 todos + 子智能体 task + 虚拟 FS backend = InStateBackend，不开 `execute`）。主 agent 读 outline 列出待写章节 → 每章派一个子agent（带该章 outline 子项 + 读标依据 + 可选 RAG 资料）写出 HTML body → 写入虚拟 FS `chapters/<id>.html` → 主 agent 收齐后产出 `{chapter_id: body_html}`。单章改写走轻量 create_agent（不必整本重规划）。

**Tech Stack:** spec105 `DeepAgent` / InStateBackend / 上下文压缩节点、LangGraph、Pydantic、pytest。锁定 deepagents 版本（§4.7 子 agent checkpoint #573，封装在本节点内）。

## 前端交互对齐（依据 C 端原型 `/content`）

- 三栏：左=提纲树（点章定位）、中=正文（富文本 HTML）、右=**章节级 AI 对话**（对当前章追加指令、重写/润色）。
- 正文是 **HTML**（`<h3>`/`<p>`/`<ul>`/`<table>`…），与原型 `chapters[].body` 同构（技术标 t1–t5、商务标 b1–b5）。
- `sourced=false` 的章对应原型「点击 AI 生成本章正文」的空状态 → content 节点要能把这些章从空生成出来（原型用 `demoBody` 占位）。
- 不臆造证据：缺失材料（如 ISO27001）只写「待补充」提示，由审查节点（spec204）标风险，不伪造。

## Global Constraints

见 `spec200-index.md`。关键：只动 `agents/bidding_agent/`；deepagent **只在此节点**，虚拟 FS 不开 `execute`（§4.5）；读 outline/read 产 chapters；不碰钱、不臆造材料；TDD；先开分支。

---

## File Structure

```
services/agent/src/agent/agents/bidding_agent/
├── prompts/content.py          # 新：CONTENT_PLANNER_PROMPT（主）/ CHAPTER_WRITER_PROMPT（子）/ REWRITE_PROMPT
├── nodes/content.py            # 改：stub → 真实 make_content_node（deepagent）+ rewrite_chapter
└── schemas.py                  # 改：加 ChapterDraft（子agent 单章产出，可选结构化）
services/agent/tests/agents/bidding_agent/
├── test_content_node.py        # 新：fake 模型 → outline 多章 → chapters{id: html}
└── test_chapter_rewrite.py     # 新：单章改写
```

---

## Interfaces

- Consumes：`state['outline']`（spec202 `Outline`）、`state['read']`（spec107）；`DeepAgent` / `InStateBackend` / `make_compressor_node`（spec105）。
- Produces：
  - `make_content_node(ctx) -> async (state)->{"chapters": {chapter_id: body_html}}`：替换 spec201 stub。
  - `rewrite_chapter(ctx, chapter_id, instruction, state) -> str`：单章改写，返回新 HTML（App `/content` 右栏对话用）。
  - `ChapterDraft`（Pydantic）：`{chapter_id, body_html}`（子agent 结构化产出）。

---

## Task 1: 章草稿 schema + 提示词（schemas.py / prompts/content.py）

**Files:** Modify `agents/bidding_agent/schemas.py`；Create `agents/bidding_agent/prompts/content.py`；Create `tests/agents/bidding_agent/test_content_node.py`（先建空壳）

- [ ] **Step 1: 开分支**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout -b phase2/spec203-content-node
```

- [ ] **Step 2: `schemas.py` 末尾加 `ChapterDraft`**

```python
class ChapterDraft(BaseModel):
    chapter_id: str
    body_html: str            # 该章正文 HTML（<h3>/<p>/<ul>/<table>…）
```

- [ ] **Step 3: 写 `prompts/content.py`**

```python
CONTENT_PLANNER_PROMPT = """你是投标标书主笔（总控）。目标：依据提纲与读标结论，组织子写手逐章产出标书正文。
你能用的工具：
- write_file/read_file（虚拟文件系统，暂存每章草稿到 chapters/<章id>.html）
- task（派子写手写某一章；把该章 outline 子项 + 读标依据 + 风格要求交给它）
流程：
1. 读 outline，列出所有待写章节（技术标 t*, 商务标 b*）。
2. 逐章用 task 指派子写手；要求其产出该章 HTML 正文（含 <h3> 小节标题 + 段落/列表/必要表格）。
3. 把子写手结果写入 chapters/<id>.html。
4. 全部完成后，回复"完成"。不要臆造缺失材料（如缺认证只写「待补充」提示）。
"""

CHAPTER_WRITER_PROMPT = """你是投标标书子写手，只负责写好指定的一章。
输入：本章标题与子项（outline）、相关读标依据、风格要求。
要求：
- 产出规范、专业、可直接评审的中文 HTML 正文：每个子项一个 <h3>，下接 <p>/<ul>/<table>。
- 紧扣评分点与★不可偏离项；语气务实、可核查；不编造证据/业绩/证书。
- 缺关键材料时，明确写「（待补充：…）」提示，不要虚构。
最后用 write_file 把本章 HTML 正文写入 chapters/<章id>.html（虚拟 FS 是唯一收稿口径）。
"""

REWRITE_PROMPT = """你是投标标书润色专家。仅就「当前章」按用户指令改写，保持 HTML 结构与专业度。
输入：原章 HTML + 用户改写指令。直接产出改写后的完整 HTML（不加解释）。"""
```

- [ ] **Step 4: 空壳测试 + 全绿**

`test_content_node.py`：
```python
def test_placeholder():
    assert True
```
Run: `cd services/agent && uv run pytest tests/agents/bidding_agent/ -q` → 全 passed

- [ ] **Step 5: 提交**

```bash
git add services/agent/src/agent/agents/bidding_agent/schemas.py services/agent/src/agent/agents/bidding_agent/prompts/content.py services/agent/tests/agents/bidding_agent/test_content_node.py
git commit -m "feat(spec203): 正文章草稿 schema + 主/子/改写提示词

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: content 节点（deepagent：主控 + 按章子agent + 虚拟 FS）

**Files:** Modify `agents/bidding_agent/nodes/content.py`；Modify `tests/agents/bidding_agent/test_content_node.py`

- [ ] **Step 1: 改 `nodes/content.py`**

```python
from __future__ import annotations
import json
from agent.framework.deepagent import DeepAgent          # spec105：deepagent 式（规划+子agent+虚拟FS）
from agent.framework.backend import InStateBackend
from agent.agents.bidding_agent.prompts.content import CONTENT_PLANNER_PROMPT, CHAPTER_WRITER_PROMPT


def make_content_node(ctx):
    """deepagent 节点：按 outline 逐章生成正文，写入 state['chapters']。"""
    async def content_node(state):
        outline = state.get("outline", {})
        read = state.get("read", {})
        backend = InStateBackend()                        # 虚拟 FS，不开 execute（§4.5）

        # 子写手：每章一个 task；直接 write_file 到 chapters/<id>.html（虚拟 FS 是唯一收稿口径）
        def chapter_subagent():
            return {"name": "chapter_writer", "prompt": CHAPTER_WRITER_PROMPT,
                    "tools": []}                          # write_file 由 deepagent 框架/backend 提供

        deep = DeepAgent(
            instructions=CONTENT_PLANNER_PROMPT,
            backend=backend,
            subagents=[chapter_subagent()],
            ctx=ctx,
        )
        user = (f"提纲：\n{json.dumps(outline, ensure_ascii=False)}\n\n"
                f"读标依据：\n{json.dumps(read, ensure_ascii=False)}\n\n"
                f"请逐章生成正文，每章草稿写入 chapters/<章id>.html。")
        await deep.ainvoke({"messages": [{"role": "user", "content": user}]})

        # 从虚拟 FS 收齐各章 HTML
        # 注意：InStateBackend.list_files 不按前缀过滤、返回全部 key，需自行过滤前缀。
        chapters = {}
        for path in await backend.list_files():
            if not path.startswith("chapters/"):
                continue
            cid = path.split("/")[-1].removesuffix(".html")
            chapters[cid] = await backend.read_file(path)
        return {"chapters": chapters}
    return content_node
```

> deepagents 子 agent checkpoint 风险（#573，§4.7）封装在本节点内；虚拟 FS 用 InStateBackend，随 checkpoint 续跑。`DeepAgent`/`InStateBackend` 的确切构造签名以 spec105 实际导出为准（Interfaces 已声明依赖）。

- [ ] **Step 2: 写 `test_content_node.py`（fake 模型 → 两章 → chapters）**

```python
import asyncio
from agent.agents.bidding_agent.nodes.content import make_content_node


class _FakeDeepResult:
    """用一个可控的 fake：直接把两章写进 backend，绕过真实 LLM 规划。"""


def test_content_node_collects_chapters(monkeypatch):
    # 用最小桩：让 InStateBackend 预置两章草稿，验证 content_node 能收齐
    from agent.framework import backend as bk

    written = {"chapters/t1.html": "<h3>1.1 需求理解</h3><p>…</p>",
               "chapters/b1.html": "<h3>1.1 投标函</h3><p>…</p>",
               "todos.txt": "（无关 key，验证前缀过滤）"}   # 模拟 list_files 返回全部 key

    class _FakeBackend:
        async def list_files(self): return list(written.keys())  # 不按前缀过滤、返回全部
        async def read_file(self, path): return written[path]

    class _FakeDeep:
        def __init__(self, *a, **k): pass
        async def ainvoke(self, _): return None

    monkeypatch.setattr("agent.agents.bidding_agent.nodes.content.InStateBackend", _FakeBackend)
    monkeypatch.setattr("agent.agents.bidding_agent.nodes.content.DeepAgent", _FakeDeep)

    node = make_content_node(ctx=object())
    out = asyncio.run(node({"outline": {"chapters": [{"id": "t1"}, {"id": "b1"}]}, "read": {}}))
    assert set(out["chapters"]) == {"t1", "b1"}
    assert out["chapters"]["t1"].startswith("<h3>")
```

> 真实 deepagent 多章生成走「Task 4 真实冒烟」（配 Key）；此处用桩验证收稿装配逻辑，保证 CI 不依赖模型。

- [ ] **Step 3: 通过 + 提交**

Run: `cd services/agent && uv run pytest tests/agents/bidding_agent/test_content_node.py -q` → passed
```bash
git add services/agent/src/agent/agents/bidding_agent/nodes/content.py services/agent/tests/agents/bidding_agent/test_content_node.py
git commit -m "feat(spec203): content 节点(deepagent 主控+按章子agent+虚拟FS 收稿)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 章节级 AI 对话改写（rewrite_chapter）

**Files:** Modify `agents/bidding_agent/nodes/content.py`；Create `tests/agents/bidding_agent/test_chapter_rewrite.py`

- [ ] **Step 1: 在 `nodes/content.py` 加 `rewrite_chapter`**

```python
from agent.framework.create_agent import build_create_agent
from agent.agents.bidding_agent.prompts.content import REWRITE_PROMPT
from langchain_core.messages import HumanMessage


async def rewrite_chapter(ctx, chapter_id: str, instruction: str, state: dict) -> str:
    """单章改写（/content 右栏对话）：取原章 HTML + 用户指令 → 新 HTML。不重规划全本。"""
    old = state.get("chapters", {}).get(chapter_id, "")
    sub = build_create_agent(REWRITE_PROMPT, [], ctx)
    msg = f"原章 HTML：\n{old}\n\n改写指令：{instruction}"
    out = await sub.ainvoke({"messages": [HumanMessage(content=msg)]})
    return out["messages"][-1].content
```

- [ ] **Step 2: 写 `test_chapter_rewrite.py`**

```python
import asyncio
from langchain_core.messages import AIMessage
from agent.agents.bidding_agent.nodes.content import rewrite_chapter


class _RewriteChat:
    def bind_tools(self, tools): return self
    async def ainvoke(self, messages):
        return AIMessage(content="<h3>3.3 服务级别承诺 SLA</h3><p>新增分级 SLA 响应时间表…</p>")


class _GW:
    def get_chat(self, **kw): return _RewriteChat()


class _Ctx:
    gateway = _GW()
    def __getattr__(self, k): return None


def test_rewrite_chapter_returns_new_html():
    state = {"chapters": {"t3": "<h3>3.3 SLA</h3><p>旧…</p>"}}
    html = asyncio.run(rewrite_chapter(_Ctx(), "t3", "补充分级 SLA 响应时间表", state))
    assert "分级 SLA 响应时间表" in html and html.startswith("<h3>")
```

- [ ] **Step 3: 通过 + 提交**

Run: `cd services/agent && uv run pytest tests/agents/bidding_agent/test_chapter_rewrite.py -q` → passed
```bash
git add services/agent/src/agent/agents/bidding_agent/nodes/content.py services/agent/tests/agents/bidding_agent/test_chapter_rewrite.py
git commit -m "feat(spec203): 章节级 AI 对话改写 rewrite_chapter

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 上下文压缩接入 + 真实冒烟 + 合并

**Files:** Modify `agents/bidding_agent/nodes/content.py`（接 `make_compressor_node`）

- [ ] **Step 1: content 的 deepagent 接上下文压缩节点（长标书必需）**

在构造 `DeepAgent` 时传入压缩配置（spec105 的 `make_compressor_node` / 压缩中间件）：

```python
from agent.framework.compressor import make_compressor_node
# DeepAgent(..., compressor=make_compressor_node(ctx.gateway, max_tokens=120_000, keep_recent=8))
```
> 写整本标书消息会膨胀；压缩节点保近 N 轮 + 摘要中段，避免超窗。具体注入点以 spec105 DeepAgent 形参为准。

- [ ] **Step 2: 真实冒烟（配 DeepSeek Key + 有 outline）**

```bash
cd services/agent
# 走 spec201 图：read→outline→content；content 应产出 chapters{t1..b5: html}
uv run pytest tests/agents/bidding_agent/ -q
```
Expected: 桩测全 passed；配 Key 时手测 content 节点产出 10 章 HTML，缺料处出现「待补充」而非编造。

- [ ] **Step 3: 全量 + lint + 合并**

```bash
cd services/agent && uv run pytest -q && uv run ruff check src
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout main && git merge --no-ff phase2/spec203-content-node -m "merge spec203: 正文 content 节点(deepagent)"
git push origin main
```

---

## 验收清单（spec203）

- [ ] `make_content_node` 用 deepagent：主控规划 + 按章子agent + 虚拟 FS（InStateBackend，不开 execute）。
- [ ] 子写手统一 `write_file` 到 `chapters/<id>.html`（无 submit_chapter 双路径）；content_node 用前缀过滤（`startswith("chapters/")`）从全量 list_files 收稿。
- [ ] 读 `state['outline']`+`state['read']` → 产 `state['chapters']={id: body_html}`（HTML 对齐原型）。
- [ ] `sourced=false` 的空状态章也能生成；缺材料写「待补充」、不臆造。
- [ ] `rewrite_chapter` 单章改写可用（/content 右栏对话）。
- [ ] 接上下文压缩节点（长标书防超窗）；deepagents 风险封装在本节点内。
- [ ] 桩测不依赖模型、全绿；真实冒烟配 Key 可跑；`pytest`+`ruff` 通过。
