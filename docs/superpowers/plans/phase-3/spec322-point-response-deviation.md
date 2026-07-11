# spec322 逐条应答 + 技术/商务偏离表生成 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 逐任务执行。

**Goal:** 招标要求逐条应答/编入偏离表时（4 份真实标书中 3 份要求，其中铁路标"不逐条响应=否决"、海警标"响应栏照抄原文=无效"），内容生成能产出规范的**技术偏离表 / 商务偏离表**章节（HTML 表格，逐条列招标要求与改写式响应），技术方案章节支持**逐条应答**写法。

**Architecture:** 纯 prompt + 节点注入层改动，无 schema 变更。偏离表章节由 spec321 的 required_structure 带入提纲（kind=form）；content planner 识别偏离表章节 → 给子写手专用指令与**全量条目数据**（读标 technical/commercial/qualification 分类的 title/value/clause_ids/star）；子写手产出固定列式 `<table>`。导出已支持 table→docx。

## Global Constraints
- 作者 `lookfree <etwuman@126.com>`；禁止 Claude 相关内容。函数 ≤80 行。
- **响应栏必须改写**（承诺句式），禁止照抄招标原文（海警标：照抄=无效报价）。
- ★/▲ 条目**必须逐条入表**；无标志的一般条目在超过 60 条时可按小节归并（防单章超模型输出上限），归并行注明"含 sec-x..y 各项要求，均无偏离"。
- 无偏离表要求的标书（required_structure 无 form 类偏离项且读标未见逐条应答要求）：行为与今天一致。

### Task A: Agent — planner/writer 偏离表模式 + 逐条应答 + review 覆盖

**Files:**
- Modify: `services/agent/src/agent/agents/bidding_agent/prompts/content.py`（PLANNER 增偏离表章节处理流程与数据下发说明；新增 `DEVIATION_TABLE_GUIDE` 常量文本供 planner 转交子写手；CHAPTER_WRITER 增逐条应答写法说明）
- Modify: `nodes/content.py`（用户消息组装：读标 technical/commercial/qualification 条目在存在偏离表类章节时**不做 slim 剥离**，保证子写手拿到全量 title/value/star；识别依据=outline 章 title 含「偏离」或 structure_ref 指向 kind=form 的偏离项）
- Modify: `prompts/review.py`（偏离表章节存在时：★ 条目缺行 → 高风险）
- Test: `tests/agents/bidding_agent/`（有偏离表章节 ⇒ planner 用户消息含 DEVIATION 指引与全量条目；无 ⇒ 与现状逐字节一致（现有断言不回归）；review 输入注入）

**偏离表列式（DEVIATION_TABLE_GUIDE 固定）:** 序号 | 招标要求条款（clause_ids/章节号） | 招标要求摘要 | 投标响应（改写承诺句式） | 偏离情况（无偏离/正偏离/负偏离） | 备注（★/▲ 标志、证明材料指引）。默认全部「无偏离」；response 逐条改写；技术偏离表取 technical 分类，商务偏离表取 commercial+qualification。

**逐条应答写法（CHAPTER_WRITER 增补）:** 主笔告知本章须逐条应答时，正文按「条款引用 → 应答承诺 → 实现措施」三段式小节组织，不漏 ★/▲。

- [ ] Task A 完成（pytest 绿 + 提交 `feat(agent): deviation table generation + point-by-point response mode`）

## 验证口径
pytest 全绿；归总 e2e：海警标生成含技术/商务偏离表章节，响应栏非原文照抄，★ 全覆盖。

## 决策记录
- 不建结构化偏离表 schema：HTML 表即终态（docx 渲染既有支持），避免为一张表引入新导出通道。
- 行数上限风险：一般条目 >60 归并（详见 Global Constraints），★/▲ 永不归并。
- 评审方法感知已在提示词审查轮先行落地（planner 按最低价法/综合评分调详略）。
