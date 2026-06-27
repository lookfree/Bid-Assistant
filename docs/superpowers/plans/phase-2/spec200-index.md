# Phase 2 · 投标全流程闭环 —— 实现计划索引（spec200）

> 把架构方案 §8 的 **Phase 2（全流程闭环）** 细化为 spec201–spec207，每个是可独立执行、独立测试的实现计划。
> 上游基线：架构 §4.2（投标工作流节点：create_agent / deepagent / 普通服务异构）、§4.2.1（述标 PPT 两段式）、§4.7（checkpointer 续状态）、Phase 1（spec101–108：框架 + 运行时 + 读标 + App 编排）。
> **Phase 2 产出目标**：在 Phase 1 的 `bidding_agent` 包内，把工作流从「只有 read」长成**完整投标流水线**——上传招标文件 → 读标 → 提纲 → 标书正文（商务标+技术标）→ 审查/查重 → **完整标书（.docx）** + **述标 PPT（.pptx）**。**agent 完全接住原型全流程。**

## 核心模型（贯穿 Phase 2，先锚定）

**一个 agent_type = 一个独立包 = 一条工作流图**。`bidding_agent` 是**唯一**注册单元；read/outline/content/review/present/export 是图里的 **6 个节点**，共享一份 `BiddingState`，步骤间用 `interrupt()` 串联。**子agent** 只出现在 **content 节点内部**（deepagent 按章并行写）。

**步骤驱动 = 每步一个 run + 共享 thread_id**（决策已定）：

```
一本标书 = 一个 thread_id（checkpointer 续 BiddingState，§4.7）
每"推进一步" = 一个独立 run_id（按步计费/可观测最干净）

App 视角：
  POST /agents/bidding_agent/runs {thread_id, input:{step|resume}}  ──▶ 跑到下一个 interrupt() 即结束本 run
  ← run 产出该节点结构化结果（落 public.agent_runs + 前端渲染）
  用户在该页确认/改 ──▶ App 再发下一个 run（同 thread_id）──▶ checkpointer 续状态、跑下一节点
```

工作流图（Phase 2 落成形态）：

```
        ┌─────────────────────────── 一个 thread_id（一本标书） ───────────────────────────┐
 file → read ─⟂─ outline ─⟂─ content ─⟂─ review ─⟂─ present ─⟂─ export
        (⟂ = interrupt 断点：用户在对应原型页确认/编辑后，App 发新 run 续跑)
 节点框架：read/outline/review/present = create_agent；content = deepagent（按章拆子agent）；export = 普通服务
 产物：read→ReadResult · outline→Outline · content→chapters[].body · review→RiskReport · present→DeckSpec→.pptx · export→.docx
```

## spec 清单与依赖顺序

| spec | 主题 | 交付物（可测） | 依赖 |
|---|---|---|---|
| **spec201** | 工作流编排骨架（★全流程地基） | `agents/bidding_agent/graph.py`：`build_bidding_workflow()` 把节点接成 `StateGraph` + 步骤间 `interrupt()`；`BiddingState` 扩全字段；`BiddingAgent` 切到编译图驱动；**每步 run/resume 契约**（run 输入带 `step`，跑到断点即止）；read 之外节点先放 stub，端到端可暂停/恢复 | Phase 1 spec104/105/107 |
| **spec202** | 提纲 outline 节点 | `nodes/outline.py` + `schemas.Outline`（技术标5章/商务标5章 + 子项 + sourced/isNew，对齐 `chapters`）；create_agent + `submit_outline`；读 `state['read']` 产 `state['outline']` | spec201 |
| **spec203** | 正文 content 节点（deepagent，★最大） | `nodes/content.py`：deepagent 按章规划 + **子agent 并行写章** + 虚拟 FS 暂存草稿；章节级「AI 对话改写」；产 `state['chapters']={chapter_id: body_html}`；上下文压缩节点（长标书必需） | spec201、spec202 |
| **spec204** | 审查 review 节点（废标+查重） | `nodes/review.py` + `schemas.RiskReport`（score + 高/中风险 + 通过项 + 定位，对齐 `riskFindings`）；招标↔投标比对（规则 + RAG）；查重；create_agent | spec201、spec202 |
| **spec205** | 述标 present 节点 + PPT 渲染 | `nodes/present.py` + `schemas.DeckSpec`（Slide{kind/scoring/bullets/notes}+QA，对齐 `present.ts`）；`render/pptx.py`（python-pptx 出 `.pptx`，§4.2.1）；时长档 10/15/20 + 模板 | spec201 |
| **spec206** | 完整标书导出 export | `nodes/export.py` + `render/docx.py`：`state['chapters']` + 提纲 → 完整标书 `.docx`（章节/目录/签章位）；普通服务节点（无 LLM） | spec201、spec203 |
| **spec207** | App 全流程编排接入（★里程碑） | 扩 spec108：`bid_projects`（一本标书=一个 thread_id）+ 按步 run 编排（预扣 stub→建 run→调 agent→SSE 中继→settle stub）+ 接 C 端 `/outline`/`/content`/`/risk`/`/present` + 产物下载（.docx/.pptx 经 MinIO） | spec201–206、Phase 1 spec108 |

> 关键路径：**spec201 骨架** →（spec202 提纲）→ **spec203 正文** →（spec204 审查 / spec205 述标 / spec206 导出 可并行）→ **spec207 App 接入里程碑**。
> spec205（述标 PPT）、spec204（审查/查重）只依赖骨架 + 有标书数据，可在 spec203 进行中并行起。

---

## Global Constraints（全局约束 · 每个 spec 隐含包含）

**承接 Phase 1（不重述，见 `../phase-1/spec100-index.md`）**
- Python 3.12 + uv + FastAPI；LangGraph 骨架 + deepagents（仅 content 节点）；pytest（+ pytest-asyncio）。
- 模型经 Model Gateway（spec103）；**不碰钱**，只上报 token/usage（§3.2 铁律①）。
- bidsaas 三 schema：`public`(App)/`langgraph`(checkpointer)/`agent`(观测)；Redis 前缀 `bid:agent:`；文件走 MinIO（bidsaas 桶）。

**Phase 2 专属**
- **一个包内生长，不重构**：所有新节点/schema/渲染落在 `agents/bidding_agent/` 内（`nodes/`、`render/`、`schemas.py`、`state.py`、`graph.py`、`prompts/`）；`bidding_agent` 仍是**唯一** agent_type。
- **节点异构、按性质选框架**（§4.2）：read/outline/review/present = `create_agent`；content = deepagent（子agent 只在此）；export = 普通服务。**deepagents 的不确定性只关在 content 节点内**，对外 run 契约不变。
- **结构化产出统一套路**：每个生成/抽取节点用 `make_submit_tool(schema)` 一次性产出 → 写入 `BiddingState` → 前端按 schema 渲染。
- **步骤间 `interrupt()` + 每步独立 run（共享 thread_id）**；产物 schema **逐字对齐 C 端原型**（`lib/sample-bid.ts`、`lib/present.ts`）。
- **渲染层确定性、归 Python 侧**：`.pptx` 用 python-pptx，`.docx` 用 python-docx；无 LLM，不碰钱（§4.2.1）。
- 不开 `execute()`（§4.5）；content 的 deepagent 用虚拟 FS backend（InStateBackend），不跑不可信代码。

---

## BiddingState 全字段（Phase 2 落成；spec201 定义，各节点填）

```python
class BiddingState(TypedDict, total=False):
    messages: Annotated[list, add_messages]
    file_key: str                 # 招标文件 MinIO key
    read: dict                    # ReadResult.model_dump()   ← read 节点（spec107）
    outline: dict                 # Outline.model_dump()      ← outline 节点（spec202）
    chapters: dict[str, str]      # {chapter_id: body_html}   ← content 节点（spec203）
    risk: dict                    # RiskReport.model_dump()   ← review 节点（spec204）
    deck: dict                    # DeckSpec.model_dump()     ← present 节点（spec205）
    artifacts: dict[str, str]     # {"docx": key, "pptx": key} ← export/present 渲染产物 key（spec205/206）
    step: str                     # 当前/目标节点（App 按步驱动用）
```

## 产物 schema → 原型源 对照（逐一对齐，开发即验收）

| schema | 字段要点 | 原型源（`lib/…`） |
|---|---|---|
| `ReadResult`（已 spec107） | 六大分类 + ScoringRow + risk_summary | `sample-bid.ts: analysisCategories / scoringTable` |
| `Outline` | `chapters[]{id,no,title,group:tech|business,sourced,items:OutlineItem[]}` | `sample-bid.ts: chapters / OutlineItem` |
| chapters body | 每章 `body` HTML（技术标 t1–t5 / 商务标 b1–b5） | `sample-bid.ts: chapters[].body/demoBody` |
| `RiskReport` | `{score,high,mid,passed, items:RiskFinding[]{level,tone,title,chapterTitle,tenderRef,advice,targetTab,targetId}, passedItems[]}` | `sample-bid.ts: riskFindings` |
| `DeckSpec` | `slides:Slide[]{id,title,scoring,bullets[],notes,kind:cover|content|end}` + `qa:QA[]{q,a}` + 时长档/模板 | `present.ts: Slide/QA/buildDeck/slideStyles` |

---

## 执行方式

每个 spec 用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实现。spec 内步骤用 `- [ ]` 复选框跟踪。先 spec201 骨架打通「可暂停/恢复的多节点图」，再按节点逐个填实，最后 spec207 接 App + C 端页面。
