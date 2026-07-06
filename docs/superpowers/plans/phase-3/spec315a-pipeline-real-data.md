# 流水线假数据清零 a 轮（原文/编辑回写/单章改写/体检/present 参数） Implementation Plan (spec315a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清零投标流水线剩余假数据：① read/outline 左栏显示真实招标原文（带条款 id 分句）；② 提纲/正文/幻灯片编辑持久化且导出用编辑后内容；③ 正文页 AI 对话=真实单章改写通道（rewrite 口径 25 分计费）；④ 正文页体检=真实 review 步；⑤ present 时长/模板真实透传。

**Architecture:** 总闸是 agent 续跑丢 input（`agent.py` 续跑分支 `payload=None`）——打通为两条通道：`run_input`（本 run 参数：duration/template 等）与 `state_overrides`（App 把已存/已编辑的 outline/chapters/deck 回灌 state，续跑节点与 render 纯函数自然吃到）。原文分句用解析层现成的 `ParsedDoc.clauses`（确定性锚点 `sec-N-cM`），read 节点落 `doc_sections` 通道随 result 交付。单章改写复用孤儿函数 `rewrite_chapter`，走 agent 新增同步路由 + `chapters` merge reducer（防单章覆盖全量），App 侧包 hold(rewrite)→调用→persist→settle。

**Tech Stack:** Agent（Python 3.12 + uv + FastAPI + LangGraph + pytest）；App API（Hono + Bun + Drizzle + bun:test，钱路径 mbp 集成测试）；Web（Next.js 16 + React 19）。

## Global Constraints

- **钱的铁律**：单章改写扣费只在 App API（hold `credit_cost.rewrite`=25 → agent 调用成功 settle 足额 / 失败 settleFailed 净 0），幂等键沿用 billing-stub `hold:/settle:/release:<ref>` 模式；agent 依旧 money-blind。
- enterprise_template_id（企业 .pptx 母版渲染）**本轮不做**——pptx.py 标注的后续加固项，透传仅覆盖内置 blue/tech/gov 三模板 + duration 10/15/20。
- 迁移如需要一律手写 + 手动 journal；集成测试 `./test-on-mbp.sh`；agent 测试 `uv run pytest`（无 DB 的节点级测试沿用 conftest 的 SubmitGateway/_FakeDeep 模式）。
- 提交英文 Conventional Commits、账号 lookfree、不加 Co-Authored-By；函数 ≤80 行、文件 ≤800 行。

## 契约（三线并行的对齐基准）

### Agent 侧（services/agent）
1. `state.py`：新增 `doc_sections: list[dict]`（`[{id,text}]`）与 `run_input: dict`（每 run 覆盖）；`chapters` 加 `_merge_dict` reducer（单章更新不再覆盖全量；全量生成返回完整 dict 语义不变）。
2. `agent.py astream` 续跑分支：`payload = {"run_input": input.get("run_input", {})}`，再叠 `input.get("state_overrides", {})` 中 `outline/chapters/deck` 白名单键；首跑分支同样带 run_input。
3. read 节点：确定性解析一次（`asyncio.to_thread(read_and_parse, file_key)`）→ `doc_sections` 落 state 且并入 read result（`{**ReadResult, "doc_sections": clauses}`）；clauses 文本直接注入 prompt 省掉工具二次解析（工具保留兜底）；`prompts/read.py` 的 clause id 示例改为与 parser 一致的 `sec-N-cM` 口径。
4. present 节点：`duration = run_input.duration if in (10,15,20) else 15`；`template = run_input.template if in (blue,tech,gov)`——注入 prompt 且提交后强制 `deck.template = template`（有传时）。
5. export 节点：docx 照旧读 state（overrides 已灌入）；若 `state.deck` 存在则**同时重渲 pptx**（artifacts merge 覆盖旧 key）——编辑后 deck 的导出由此生效。
6. 新路由 `POST /agents/{agent_type}/threads/{thread_id}/chapters/rewrite`：body `{chapter_id, instruction, model?}` → 校验 thread state 有该章 → `rewrite_chapter` → `graph.aupdate_state({"chapters": {chapter_id: html}})`（merge reducer 保其余章）→ `{chapter_id, html}`；LLM 失败 502 带可读错误。

### App API 侧（apps/api）
1. `PATCH /api/projects/:id/steps/:step`（step ∈ outline|content|present）：body `{result}`（camel）→ `toSnake`（新写 lib/case.ts 的逆函数）→ 覆写该步 done 行的 `project_steps.result`（无 done 行 404；属主校验；zod 浅校验非空对象）→ `{ok:true}`。
2. `POST /api/projects/:id/chapters/:chapterId/rewrite`：body `{instruction: string min1}` → hold(`rewrite`, ref=新 uuid) → 调 agent rewrite 路由（同 agent-client 基址，超时放宽 120s）→ 成功：把新 html 合入 content 步 result.chapters + settle 足额 → `{chapterId, html, cost}`；agent 报错：settleFailed 净 0 → 502；余额不足 402。**mbp 集成测试**：hold/settle/失败退还/幂等、余额不足 402、result 持久化。
3. `POST /:id/steps/:step` 组 input 升级：`{text, file_key, step, run_input, state_overrides}`——present 步 body 收 `{duration?, template?}` 进 run_input；content 步带 `state_overrides.outline`（已存/已编辑提纲）；export 步带 `state_overrides.{outline,chapters,deck}`（皆取 project_steps.result 现值，编辑过=编辑后）。
4. read 步 result 自动含 doc_sections（存储/toCamel 链路零改动，验证即可）。

### Web 侧（apps/web）
1. read/outline 左栏：`sample-bid.tenderDoc` 换 read 结果的 `docSections`（条款 id 锚点定位沿用现有 clauseIds 交互）；无真实项目仍回落示例。
2. outline 页：增删改后「保存」→ PATCH steps/outline（把当前树序列化回 Outline 形状）。
3. content 页:编辑器失焦/保存 → PATCH steps/content;**AI 对话接真**——选中章节+指令 → POST chapters/:id/rewrite(对话框显示消耗 25 分,成功替换该章正文+刷新余额),删假 setTimeout;**体检接真**——`useStep("review")` 真跑(content 未完成时按钮禁用提示),结果渲染沿用 risk 页 derive,删 riskFindings 示例。
4. present 页：时长/模板选择器的值随 runStep body 透传；幻灯片编辑「保存」→ PATCH steps/present；导出自动带编辑后 deck（后端 overrides）。

## Tasks

- [x] **Task A（agent）**：契约 1-6 + pytest（doc_sections 落 state/result、续跑 run_input+overrides 灌入、rewrite 路由单章合并不覆盖、present duration/template、export 重渲 pptx）
- [x] **Task B（api）**：契约 1-4 + mbp 集成测试（PATCH 属主/形状、rewrite 计费全路径、steps input 组装）
- [x] **Task C（web）**：契约 1-4 + tsc/build
- [x] **Task D**：/code-review 全修 → mbp 全绿 → commit → 部署 mbp

## 315b（下一轮）

标书查重引擎（credit_cost.dedupe=100，钱从严）、终极审核表持久化+导出、enterprise_template_id 母版渲染、双读标路径收敛。
