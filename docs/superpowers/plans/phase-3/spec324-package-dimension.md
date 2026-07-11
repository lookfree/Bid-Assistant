# spec324 包件维度：识别 + 选包 + 按包生成 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 逐任务执行。

**Goal:** 多包件招标（公安三所 3 包、铁路标 4 包，兼投不兼中/各自限价）支持：读标识别包件划分 → 用户选投哪个包 → 提纲/正文/导出只覆盖所选包件。简化模型：**一个项目一次投一个包**（要投多包=建多个项目，符合"分开制作投标文件"的真实要求）。

**Architecture:** ReadResult 增 `packages`（additive，单包标书为空）；项目表增 `selected_package` jsonb（{id,name}，可空）；App 在 outline 及之后各步的 run_input 带 `package`；agent outline/content 节点注入范围约束；export 封面带包件名。packages 为空或未选包 ⇒ 全链路行为与今天一致。

## Global Constraints
- 作者 `lookfree <etwuman@126.com>`；禁止 Claude 相关内容。函数 ≤80 行。
- 单包/未选包行为逐字节不变。选包只影响 outline 之后的步骤（read 面向全文，不分包）。
- 迁移手写 SQL（沿 0026 惯例，drizzle snapshot 已滞后不可 db:generate）。

### Task A: Agent — packages 抽取 + 按包范围约束 + 封面包件名

**Files:**
- Modify: `schemas.py`（`PackageInfo{id:str, name:str, budget:str="", notes:str="", clause_ids:list[str]=[]}` + `ReadResult.packages: list[PackageInfo] = []`）
- Modify: `prompts/read.py`（识别「分包/包件/标段」划分：多包件时逐包抽 id(p1..)/名称/预算或限价/关键差异 notes；单包留空不臆造）
- Modify: `nodes/outline.py`、`nodes/content.py`（`run_input.package` 存在 ⇒ 用户消息追加「本项目仅投包件《name》(id)：提纲/正文仅覆盖该包件的需求、评分与构成，其它包件内容一律忽略；涉及分包件评分表/偏离表仅取该包件」；缺省 ⇒ 逐字节一致）
- Modify: `render/docx.py` + `nodes/export.py`（run_input.package 存在 ⇒ 封面项目名下加「包件：《name》」一行）
- Test: schema 回归 + outline/content 注入两态断言 + docx 封面含包件名

- [ ] Task A（提交 `feat(agent): package extraction + package-scoped outline/content/export`）

### Task B: App API — selected_package 列 + 选包接口 + run_input 下发

**Files:**
- Modify: `apps/api/src/db/schema/`（bidProjects 增 `selectedPackage` jsonb 可空）+ 手写迁移 0027
- Modify: `routes/projects.ts`（新 `PATCH /:id/package` body `{id,name}`（zod，均 min 1）设置/`null` 清除；步骤 run 创建处：`selectedPackage` 存在且 step≠read ⇒ run_input 加 `package`；GET 详情回 `selectedPackage`）
- Test: PATCH 往返/属主隔离/步骤 run_input 含 package（read 步不含）

- [ ] Task B（提交 `feat(api): project selected package + package-scoped run input`）

### Task C: Web — 读标页选包卡

**Files:**
- Modify: `apps/web/lib/bid-types.ts`（PackageInfo）+ read 页（`read.packages.length>1` 时在结果区顶部渲染「本项目为多包件招标，请选择投标包件」单选卡片组：名称+预算+notes；选择 → 调 PATCH /:id/package → toast；已选高亮可换选；≤1 包不渲染）
- Modify: `apps/web/lib/project.ts`（setProjectPackage API）
- Test: tsc + build

- [ ] Task C（提交 `feat(web): package selection card on read page`）

## 验证口径
agent/mbp/web 三门禁绿。归总 e2e：公安三所标读出 3 包件,选包件1 → 提纲仅含实网攻防内容、封面带包件名。

## 决策记录
- 一项目一包（不做项目内多包并行）：兼投需分开制作投标文件本就是招标要求,多包=多项目模型最简且合规。
- 选包放 outline 前而非 read 前：read 全文读标才能发现包件划分。
