# spec205.1 · 述标(present)生成健壮性:强制提交重试 + 两段式拆分 Implementation Plan

> 命名:present 节点(spec205)的健壮性后续,故 spec205.1(phase-2)。历史提交信息/代码注释里以 "spec318" 标注的即本 spec。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复述标(present)步骤反复"生成失败"——根因是 DeepSeek 产出的 DeckSpec 单次 JSON 太大太深(12–15 页 slides,每页含一整段口播稿 notes + qa),模型把大 JSON 的尾部写成非法语法(实测 `JSONDecodeError: Extra data`,qa 处 `"qa"::` + 幻觉包装键),langchain 丢进 `invalid_tool_calls` 导致 `msg.tool_calls` 为空,而 `_forced_submit` 把这种情况当"没提交"**一次就放弃**(3 次重试预算白留)。两条修复:①`_forced_submit` 对"模型试了但 JSON 非法"喂回报错并重试;②present 改两段式,把一次要吐的 JSON 变小,从根上降低翻车率。

**Architecture:** Fix 1 改 `framework/create_agent.py` 的 `_forced_submit` 单点:识别 `invalid_tool_calls`(模型意图提交但参数非合法 JSON),构造修正 `ToolMessage` 喂回、消耗剩余 attempts,仅在"模型完全没产出提交调用"(如 fake 模型/拒答)时才放弃。此修复对所有 submit 节点通用(读标/提纲/审查/述标共用该函数),但只有述标这种超大输出会触发。Fix 2 只改 `nodes/present.py` + present 提示词 + schemas:present_node 从"一次产完整 DeckSpec"改为两段——先产 `DeckDraft`(slides 骨架 title/scoring/bullets/kind + qa,**不含 notes**,JSON 紧凑)、再对定稿 slides 产 `SlideNotes`(每页口播稿),App 侧合并成最终 `DeckSpec` 交 `render_pptx`(渲染层契约不变)。其余节点、App 契约、计费一律不动。

**Tech Stack:** Python 3.12 + LangChain(`bind_tools`/`invalid_tool_calls`/`ToolMessage`)+ Pydantic + `uv run pytest`。

## Global Constraints

- **契约冻结**:`render_pptx(DeckSpec)` 入参 `DeckSpec` 形状不变(最终仍产出 slides 带 notes + qa 的完整 DeckSpec);App 侧 present 步 result(`state['deck'] = DeckSpec.model_dump()`)、artifacts.pptx、SSE 事件、计费口径全不动。present 仍是一个 graph 节点、一个 run。
- **money-blind 不变**:两段式是节点**内部**两次 LLM 调用,对 App 是同一个 present run;不新增 hold/settle,用量照旧经 `record_ctx_usage` 上报(两次调用各记一条,settle 汇总自然含两段)。
- **Fix 1 不改既有成功路径语义**:Pydantic 校验失败仍喂回重试(现有行为);"模型完全没提交调用"仍放弃(现有行为);**只新增**"模型提交了但 JSON 非法"的喂回重试分支——此前它错误地走了"放弃"。读标/提纲/审查节点行为不得回归(它们本就少触发 invalid,新增分支对它们是纯增益)。
- **两段式失败仍 fail-closed**:任一段 `run_submit_agent` 未提交 → 抛 RuntimeError → present run 落 failed(现有语义,客户端重发即重试整节点);notes 段失败不得吞成"空口播稿当成功交付"。
- 迁移:无(schema 是 Pydantic,非 DB)。
- 提交英文 Conventional Commits、lookfree、无 Co-Authored-By;函数 ≤80 行、文件 ≤800 行;关键方法注释解释"为什么"。
- 验证:`cd services/agent && uv run pytest`;full pass → `/code-review` 全修 → 部署 mbp → 用你的真实项目端到端验收述标能出 pptx。

## 契约

### 现状代码(本轮要动的位置,行号为改造前)
- `services/agent/src/agent/framework/create_agent.py`:`_forced_submit`(73-93)——`call is None` 时(85-87)**立即 return 放弃**,不看 `invalid_tool_calls`。本轮加"非法提交喂回重试"分支。
- `services/agent/src/agent/agents/bidding_agent/nodes/present.py`:`present_node`(20-42)一次 `run_submit_agent(..., "submit_deck", DeckSpec, ...)`。本轮改两段。
- `services/agent/src/agent/agents/bidding_agent/schemas.py`:`Slide`(98-104)含 `notes`;`DeckSpec`(112-118)。本轮加 `SlideDraft`/`DeckDraft`/`SlideNote`/`SlideNotes`,`Slide`/`DeckSpec` 不改(最终产物仍是它们)。
- `services/agent/src/agent/agents/bidding_agent/prompts/present.py`:`PRESENT_SYSTEM_PROMPT`。本轮拆成骨架版 + 口播稿版两个提示词。

### Fix 1:`_forced_submit` 识别 invalid_tool_calls 并重试
改造循环(保持 attempts=3、tool_choice 强制、Pydantic 失败喂回不变),新增分支:
```python
for _ in range(attempts):
    msg = await forced.ainvoke(messages)
    record_ctx_usage(ctx, msg, node="agent", model=getattr(llm, "model_name", None))
    call = next((c for c in (getattr(msg, "tool_calls", None) or []) if c["name"] == tool_name), None)
    if call is not None:
        try:
            await submit.ainvoke(call["args"]); return          # 校验通过,结果已捕获
        except Exception as e:  # noqa: BLE001  Pydantic 失败喂回(现有行为)
            messages = [*messages, msg, ToolMessage(content=f"提交被拒绝：{e}。请修正字段后重新提交。", tool_call_id=call["id"])]
            continue
    # 新增:模型意图提交但参数不是合法 JSON(大嵌套 JSON 高频翻车,实测 qa 尾部写坏)→ 喂回报错重试,
    # 而非放弃(此前 bug:invalid 调用被当"没提交",3 次预算白留)。
    invalid = next((ic for ic in (getattr(msg, "invalid_tool_calls", None) or []) if ic.get("name") == tool_name), None)
    if invalid is not None:
        messages = [*messages, msg, ToolMessage(
            content=f"submit 参数不是合法 JSON（{invalid.get('error')}）。只输出一个合法 JSON 对象，一次性提交，不要多余包装键或注释。",
            tool_call_id=invalid.get("id") or "invalid")]
        continue
    return                                                       # 模型完全没产出提交调用(fake/拒答)→ 交上层抛"未提交"
```
- 边界:`ToolMessage` 需 `tool_call_id`——invalid 调用的 `id` 可能缺,兜底常量串(仅用于把报错串进对话,不影响正确性)。函数仍 ≤80 行(超则把分支抽小 helper)。

### Fix 2:present 两段式
新增 schemas(`schemas.py`):
```python
class SlideDraft(BaseModel):                    # 骨架:不含 notes(最大最易崩的自由字段)
    id: str
    title: str
    scoring: str = ""
    bullets: list[str] = Field(default_factory=list)
    kind: Literal["cover", "content", "end"] = "content"

class DeckDraft(BaseModel):
    title: str = ""
    duration: Literal[10, 15, 20] = 15
    template: Literal["blue", "tech", "gov"] = "blue"
    enterprise_template_id: str | None = None
    slides: list[SlideDraft]
    qa: list[QA] = Field(default_factory=list)

class SlideNote(BaseModel):
    id: str                                     # 对应 SlideDraft.id
    notes: str

class SlideNotes(BaseModel):
    notes: list[SlideNote]
```
`present_node` 两段(节点其余不变:duration/template 取值、_plain、render、upload、返回形状):
1. **骨架段**:`draft = await run_submit_agent(ctx, PRESENT_SKELETON_PROMPT, user, "submit_deck_draft", DeckDraft, "提交述标骨架")`。
2. **口播稿段**:以骨架 slides(id+title+scoring+bullets,不含正文全文,紧凑)为输入,`notes = await run_submit_agent(ctx, PRESENT_NOTES_PROMPT, notes_user, "submit_slide_notes", SlideNotes, "提交每页口播稿")`;`notes_user` 含 duration + 各页 {id,title,scoring,bullets}。
3. **合并**:`note_map = {n.id: n.notes for n in notes.notes}`;`slides = [Slide(**d.model_dump(), notes=note_map.get(d.id, "")) for d in draft.slides]`(缺失页 notes 兜底空串,不因个别页缺口播稿整体失败);`deck = DeckSpec(title=draft.title, duration=draft.duration, template=draft.template, enterprise_template_id=draft.enterprise_template_id, slides=slides, qa=draft.qa)`。
4. 之后 `if template: deck.template = template` / `render_pptx` / `upload_artifact` / 返回 `{"deck": deck.model_dump(), "artifacts": {"pptx": key}}` 一律不变。

提示词(`prompts/present.py`)拆两个:
- `PRESENT_SKELETON_PROMPT`:原要求 1/3/5(页型/页数按时长/模板)+ 每页 title/scoring/bullets(3–5 条)+ qa(3–6 条);**明确"本步不产 notes 口播稿"**,只提交 `submit_deck_draft`。
- `PRESENT_NOTES_PROMPT`:"为给定的每页(id/title/scoring/bullets)写口播稿 notes(自然口语、可照读、每页 2–4 句),用 submit_slide_notes 一次性提交,notes 数组每项 {id, notes},id 必须与输入页 id 一一对应。"

### 验证口径
- `uv run pytest`(services/agent):
  - **Fix 1 单测**(`tests/framework/` 或 `test_forced_submit.py` 新建):用 fake `gateway.get_chat` 返回可编排的 fake chat——
    ① 第一轮返回带 `invalid_tool_calls`(name=submit_x)、`tool_calls` 空的 AIMessage,第二轮返回合法 `tool_calls` → 断言 `run_submit_agent`/`_forced_submit` 最终成功(证明 invalid 触发了重试而非放弃),且 fake 被调用 2 次;
    ② 连续 3 轮都 invalid → 抛 RuntimeError"未提交"(预算耗尽);
    ③ 第一轮 `tool_calls` 合法但 Pydantic 失败、第二轮合法通过 → 成功(回归:既有喂回重试不破);
    ④ 模型完全无 tool_calls 也无 invalid_tool_calls(fake/拒答)→ 放弃(回归)。
  - **Fix 2 单测**(present):mock `run_submit_agent` 依次返回 `DeckDraft`(2 页)与 `SlideNotes`(对应 2 页 notes)→ 断言 present_node 产出的 `deck.slides` 每页 notes 正确合并、qa 来自 draft、template 透传;某页缺 notes → 该页 notes 为空串不报错;render/upload mock 断言被调。
  - 既有 present/其它节点测试保持绿(契约未破)。
- 端到端(部署后手测,mbp):用真实项目跑述标 → 出 .pptx、present 步 done;查 `agent_token_usage` 该 run 有两条 agent 调用(骨架+口播稿)。

## Tasks

- [ ] **Task A(Fix 1)**:`_forced_submit` 加 invalid_tool_calls 喂回重试分支 + 四态单测(invalid→重试成功/耗尽/Pydantic 回归/彻底无调用回归)。
- [ ] **Task B(Fix 2)**:schemas 加 DeckDraft/SlideNotes + present_node 两段式 + 提示词拆分 + present 合并单测。
- [x] **Task C(验证/部署)**:`uv run pytest` 全绿 → `/code-review` 全修 → 合并 main → 部署 mbp → 真实项目端到端验收述标出 pptx。

## 决策记录

1. **Fix 1 放在 `_forced_submit` 单点,通用受益**:所有 submit 节点共用该函数;"模型试了但 JSON 非法就放弃"是通用 bug,只是述标输出最大最先暴露。在此单点修,读标/提纲/审查同样获得健壮性,零额外面。
2. **Fix 2 拆"骨架 + 口播稿"而非"slides + qa"**:实测 JSON 在 qa 尾部崩,但根因是**总体积大**;`notes`(每页一整段口播稿)是最大最自由的字段,移出后骨架 JSON 体积最小、最稳。qa 紧凑,留在骨架段。契合架构文档述标"两段式(智能体产稿+渲染层产文件)"的分层精神。
3. **两段式仍是一个 graph 节点/一个 run**:对 App/计费透明(money-blind 不变),不改工作流拓扑、不改 App 契约;只是节点内多一次 LLM 调用。代价是 present 多一次调用的延迟/token,换取可靠出稿——述标是流水线最后一步,可靠性优先。
4. **缺页 notes 兜底空串不整体失败**:口播稿是辅助(演讲者可自行补),个别页缺失不该让整个述标 run 失败;但**两段任一段完全未提交**仍 fail-closed 抛错(区分"部分缺"与"根本没产出")。
5. **不加 max_tokens**:实测 finish_reason=tool_calls(非 length),不是截断,加 max_tokens 无关;不做无关改动。

## 本轮不做(候选池)
- notes 段按页并行/分批(进一步降体积):两段式已足够,页并行留观测数据后再说。
- 述标模型专项切换(spec311 运营杠杆):属配置,非本轮代码。
- 骨架段也拆 qa 独立第三段:qa 紧凑,暂无需。
