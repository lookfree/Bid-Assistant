# spec328 · 标书审查独立模块 实现计划

**Goal:** 把「标书审查」从流水线步骤升级为**独立可入口的模块**：
① 选择「我的标书」中已生成正文的项目审查（今天已有,保持不变）；
② **上传线下生成的标书**（docx/pdf）直接审查——可选附带招标文件：附了做**对照审查**（含读标,能查未响应★条款/偏离）,没附做**通用自查**（完整性/格式/常见废标点,结果明示局限）。（2026-07-22 用户裁决：两种都支持）

## 设计（复用优先,不另起炉灶）

核心洞察：review 节点只吃 `state{read, outline, chapters, run_input}` → RiskReport,与流水线位置无耦合。
外部标书 = 确定性解析成 chapters（按章节标题分节,复用 parse_bytes）,不需要 LLM 生成步骤。

```
审查专用项目 kind='review'（bid_projects 加列,migration 0022,默认 'bid' 不影响存量）
  ├─ 带招标文件:  draft → read（现有读标,现有计费）→ review（graph 新增 read→review 条件边跳过 outline/content）
  └─ 不带招标文件: 直接 review（graph 新增 START→review 条件入口;read 为空,通用自查模式）
  review 的 chapters 来源: run_input.bid_file_key → review 节点内确定性解析（无 LLM,不加价）
  review 完成: review-kind 项目直接推进 done（nextStep 按 kind 分叉）
```

- **计费**：读标/审查沿用现有 credit_cost.read / credit_cost.review 口径,无新键;解析不收费。
- **Agent**（services/agent）
  - graph.py：`START → read|review` 条件入口（新线程 + run_input.step=review）;`read → outline|review` 条件边（对照审查跳过提纲/正文）。沿用 review→export 条件边的既有模式。
  - review 节点：`state.chapters` 为空且 `run_input.bid_file_key` 存在 → `read_and_parse` 解析上传标书,按节拼 chapters（标题为章名,正文转 <p>）;read 为空时提示词切「通用自查」口径并在报告首条明示「未提供招标文件,未做对照审查」。
- **App API**（apps/api）
  - migration 0022：`bid_projects ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'bid'` + journal 追加。
  - `POST /api/projects/review`：`{bidFileKey, tenderFileKey?, name?}` → 建 kind='review' 项目（带招标文件 currentStep='read' status='draft';不带 currentStep='review' status='running'）,bid_file_key 存 tenderFileKeys 之外的新列?——**存 run 侧**：随 review 步 run_input 下发,项目行加 `bid_file_key` 列（同 0022）。
  - 步序闸：kind='review' 时 allowed = read（draft）| review（currentStep∈{outline,review}）;禁 outline/content/present/export。
  - 推进：`nextStep(step, kind)`——review-kind 的 read→review、review→done;普通项目不变。
- **Web**（apps/web）
  - /risk 页顶部新增入口态（无当前项目或当前项目不可审时）：两张卡——「选择我的标书」（列出 content 已完成的项目,点选即切当前项目并进入现有审查流）/「上传线下标书」（上传标书 + 可选招标文件 → POST /projects/review → 带招标的引导先读标,不带的直接可点审查）。
  - review-kind 项目在 /risk 页展示同款风险报告（result 形状一致,零改动）;导出审查报告按钮沿用。
  - 项目列表 stepMap 兼容 kind='review'（点击进 /risk）。

## Tasks（TDD,每任务一测一实现一提交）

- [ ] T1 agent：graph 条件入口/条件边 + 路由函数单测（START→review、read→review、缺省不变）。
- [ ] T2 agent：review 节点外部标书解析（bid_file_key→chapters;read 空→通用自查提示词）+ 节点测试（mock gateway）。
- [ ] T3 api：migration 0022（kind + bid_file_key,幂等）+ journal;POST /projects/review 路由 + 真库测试（两种模式建项、越权/缺参）。
- [ ] T4 api：review-kind 步序闸与推进分叉 + 真库测试（read→review→done;禁 outline/export）。
- [ ] T5 web：/risk 入口态双卡 + 上传流 + 项目选择器;typecheck+既有测试全绿。
- [ ] T6 收尾：mbp 全量相关套件绿;部署 230(agent/api/web);容器内验证;本文件勾账。

## 验收

- 已有项目审查流程逐字节不变（kind 默认 'bid'）。
- 上传标书+招标文件：读标(计费)→审查(计费)→风险报告可看可导出,能查出未响应★条款。
- 只上传标书：直接审查(计费),报告首条明示「未对照招标文件」;通用自查项正常产出。
- 生成中/越权/缺文件等边界:409/404/400 全覆盖;不动钱路径既有语义。
