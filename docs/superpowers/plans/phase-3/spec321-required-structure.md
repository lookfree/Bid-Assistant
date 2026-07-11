# spec321 投标文件构成抽取 + 提纲对齐 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 逐任务执行。步骤用 `- [ ]`。

**Goal:** 读标时从招标文件的「投标/应答/响应文件格式」章抽出**投标文件构成清单**（required_structure：分册、必备章节、必备表单及份数/密封/签章要求）；提纲以该清单为骨架生成（每个必备构成有对应章节）；审查校验构成覆盖。解决 4 份真实标书共同的废标级问题：构成/格式不对齐=形式审查不过。

**Architecture:** ReadResult 增 `required_structure`（additive，旧数据无该字段=空列表）；OutlineChapter 增 `structure_ref`（对应构成项 id，可空）；outline 节点把构成清单注入 prompt 作为骨架约束；review 节点输入构成清单做覆盖比对。价格/资格类构成（报价表、营业执照等）不生成正文——提纲仍须列章占位（structure_ref 标记），正文写「按招标格式填写/附证明材料」引导。

## Global Constraints

- 作者 `lookfree <etwuman@126.com>`；禁止任何 Claude 相关内容。Conventional Commits 英文。函数 ≤80 行。
- **向后兼容**：required_structure 为空（旧读标结果/未识别出格式章）时，outline/review 行为与今天一致（骨架约束不注入）。
- 忠于原文：构成项必须有 clause_ids/source_quote 溯源，不臆造。

---

### Task A: Agent — schema + read 抽取 + outline 对齐 + review 覆盖

**Files:**
- Modify: `services/agent/src/agent/agents/bidding_agent/schemas.py`
- Modify: `prompts/read.py`、`prompts/outline.py`、`prompts/review.py`
- Modify: `nodes/outline.py`（注入 required_structure）、`nodes/review.py`（同）
- Test: `tests/agents/bidding_agent/`（schema 校验 + 节点输入注入断言）

**Interfaces:**
```python
class StructureItem(BaseModel):
    id: str                      # s1, s2...
    title: str                   # 如「开标一览表」「技术偏离表」「资格证明文件（分册）」
    kind: Literal["volume", "chapter", "form", "rule"]  # 分册/章节/表单/程序性要求(份数密封签章)
    required: bool = True        # 招标文件强制=true；可选项=false
    notes: str = ""              # 份数/密封/签章/装订等操作说明（kind=rule 为主）
    clause_ids: list[str] = []
    source_quote: str = ""

class ReadResult(...):           # 增字段
    required_structure: list[StructureItem] = []

class OutlineChapter(...):       # 增字段
    structure_ref: str | None = None   # 对应 required_structure 项 id
```
- read prompt：新增第 2.5 步——定位「投标文件格式/应答文件构成」类章节，逐项抽 required_structure；kind=rule 的项（份数/密封/封套/签章）与 format 分类互补不重复罗列（format 供人读，structure 供机器对齐）。
- outline 节点：`state["read"].get("required_structure")` 非空 ⇒ 注入 prompt：「投标文件构成清单（骨架，必须每个 required 项都有对应章节并置 structure_ref；kind=rule 除外）」；价格/资格类表单章正文占位即可。outline prompt 增说明 structure_ref 填法。
- review 节点：required_structure 注入用户消息；prompt 增检查——required 构成项（kind≠rule）无对应章节（structure_ref 或标题匹配）→ 高风险。

- [ ] Task A 完成（pytest 绿 + 提交 `feat(agent): required bid-document structure extraction + outline/review alignment`）

### Task B: App API — outline PATCH 放行 structure_ref

**Files:**
- Modify: `apps/api/src/routes/projects.ts`（outlineChapterSchema 增 `structureRef`/`structure_ref` 可选透传——**先读现状确认该 schema 的字段命名风格（camel/snake）与 toCamel 转换位置**，保持一致；确保 PATCH 编辑提纲不剥掉该字段）
- Test: `apps/api/test/`（带 structure_ref 的 outline PATCH 往返不丢字段）

- [ ] Task B 完成（mbp 测试绿 + 提交 `feat(api): outline schema passes through structure_ref`）

### Task C: Web — 读标页构成清单卡片

**Files:**
- Modify: `apps/web/lib/bid-types.ts`（StructureItem + AnalysisResult.requiredStructure 类型）
- Modify: `apps/web/app/(tool)/read/`（读标结果页增「投标文件构成」卡片：清单展示 kind 徽标/required 标记/notes，点击定位条款——沿用既有 clause 定位交互；无数据不渲染）
- Test: `bunx tsc --noEmit` + build

- [ ] Task C 完成（提交 `feat(web): required bid-document structure card on read page`）

## 验证口径
Agent pytest 全绿；App mbp 绿；web build 绿。归总 e2e：南瑞标读出构成清单（价格/商务/技术三册+偏差表+应答函），提纲每个 required 项有章。

## 决策记录
- structure 与 format 分类并存：format 是给人看的解读条目，required_structure 是给 outline/review 对齐的机器清单——用途不同，允许内容重叠。
- 价格表单不生成数字（钱由用户填），正文占位+格式引导；spec322 的偏离表是例外（可全自动生成）。
