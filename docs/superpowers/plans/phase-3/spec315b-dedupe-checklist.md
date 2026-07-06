# 标书查重引擎 + 终极审核表持久化 Implementation Plan (spec315b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消灭 risk 页最后两个假交互：① 查重 tab 接真实引擎（多份投标围标自查，dedupe=100 分计费）；② 终极审核表持久化（状态/责任人/备注落库）+ 真实 Word 导出（export=20 分计费）。做完后 C 端无任何假数据/假交互。

**Architecture:** 查重按架构文档定性走**纯算法**（非 LLM）：agent 服务新增同步查重服务/路由（不进 LangGraph thread），复用 `parsing/` 解析层并扩展图片（Pillow dHash）与文档属性（python-docx core_properties / pypdf metadata）抽取；2-3 份文件两两比对无需 LSH——shingle Jaccard + difflib LCS 精排即可。App API 只做鉴权+计费编排+中继（agent money-blind），照抄 rewrite 路由的「非步独立计费范式」。审核表新表 `project_checklists`（绑 userId+可空 projectId），导出走 agent 无状态渲染（App 把 groups+状态灌给 agent，agent 复用 render/docx 原语出字节落 MinIO，App 预签名返回 URL）。

**Tech Stack:** Agent（Python：datasketch 不引入，Pillow 新增）；App API（Hono+Drizzle+zod，钱路径 mbp 测试）；Web（risk/page.tsx 两 tab 接线）。

## Global Constraints

- **钱的铁律**：dedupe hold 100 / checklist 导出 hold `export`=20，全在 App API；成功 settle 足额、失败 settleFailed 净 0、settle 独立 try 不因瞬断退已交付产物（315a 已确立的范式）；agent 不碰任何计费概念。
- 查重口径=UI 已锁死文案：**仅本次上传的 2–3 份投标文件之间两两比对**（可选招标文件基线扣除），非全网/非历史库。
- 迁移手写+手动 journal；集成测试 `./test-on-mbp.sh`；agent `uv run pytest`。
- 提交英文 Conventional Commits、lookfree、无 Co-Authored-By；函数 ≤80 行、文件 ≤800 行。

## 契约

### Agent 侧
1. `parsing/` 扩展：`extract_media_hashes(bytes, kind)`（docx 解压 media/ 图片 → Pillow dHash 64bit 列表；pdf 跳过 v1）、`extract_doc_meta(bytes, kind)`（docx core_properties 的 author/last_modified_by/company/created；pdf metadata 对应字段）。挂进 ParsedDoc.meta 或独立函数，实现者定。
2. 新路由 `POST /dedupe`（同步，无 thread）：body `{files: [{key, label}] (2-3), tender_key?, dims: ["text"|"image"|"meta"|"baseline"], strategy: "fast"|"standard"|"strict"}` →
   - text：clauses 分句 → k-shingle（strategy 定 k 与阈值：fast k=8/阈值宽、standard k=5、strict k=3）Jaccard + 高分句对 difflib LCS 摘录命中片段；baseline 开且有 tender_key 时先扣除与招标文件高度相似的句（法定引用不算抄）
   - image：两文件 dHash 集合的汉明近邻命中数
   - meta：author/company/last_modified_by 相同即命中
   - 响应：`{pairs: [{a, b, score(0-100), tone: destructive|warning|success, note, hits: [{dim, a_text?, b_text?, detail}] }], overall: {max_score, high_pairs}, dims_run: [...]}`；tone 阈值 strict/standard/fast 各档（≥70 destructive / ≥40 warning / else success，按 strategy 平移）
   - 解析失败某文件 → 422 `{error, file}`；不足 2 份 400
3. 新路由 `POST /render/checklist`（同步无状态）：body `{title, project_name?, groups: [{id, title, items: [{text, status, owner, note, library_hit}]}]}` → 复用 render/docx 原语渲染（表格+签字/日期栏）→ 上传 MinIO `artifacts/checklist/<uuid>.docx` → `{key}`。

### App API 侧
1. 迁移 `project_checklists`：id/userId(FK cascade)/projectId(FK cascade, **nullable**——独立工具无项目时用户级默认行)/items(jsonb `{"<组id-序号>": {status, owner, note}}`)/updatedAt/createdAt；唯一约束 (user_id, project_id) **NULLS NOT DISTINCT**（PG≥15）。
2. `GET /api/checklist?projectId=`（可空）→ `{items}`（无行返回空对象）；`PUT /api/checklist`：body `{projectId?, items}`（upsert）。
3. `POST /api/dedupe`：body `{fileKeys(2-3), tenderKey?, dims, strategy}` → **fileKeys 属主校验**（project_files by key+userId，非本人 400）→ `preDeduct(userId,"dedupe",ref)`（402）→ 调 agent /dedupe（失败 settleFailed → 502）→ settle 独立 try → 落 `dedupe_runs` 审计行（id/userId/params/result jsonb/cost/createdAt，同迁移）→ 返回结果。
4. `POST /api/checklist/export`：body `{projectId?, title?, groups}`（前端把模板+状态合成后传）→ `preDeduct(userId,"export",ref)` → agent /render/checklist → `presignGet(key)` → settle 独立 try → `{url}`；失败 settleFailed 502。
5. agent-client 加 `dedupe()`/`renderChecklist()`（超时 120s）。

### Web 侧（risk/page.tsx 两 tab）
1. 查重 tab：上传走既有 `/files` 三段直传拿 key；「开始查重」前显示消耗 100 分（creditCostValue "dedupe"）确认 → POST /api/dedupe → 渲染真实 pairs/overall/hits（删 dedupResults/68% 硬编码与假 setTimeout）；402 去充值、502 可读错误。
2. 审核表 tab：挂载 GET /api/checklist（带当前 projectId 或空）回填三 map；编辑防抖 PUT；导出按钮 → 确认（20 分）→ POST /api/checklist/export → 打开 url（删假 setTimeout；Excel/PDF 入口本轮隐藏或标注即将上线，只做 Word）。

## Tasks

- [ ] **Task A（agent）**：parsing 扩展 + /dedupe + /render/checklist + pytest（含中文文本相似度用例、基线扣除、meta 命中、渲染冒烟）
- [ ] **Task B（api）**：迁移（project_checklists + dedupe_runs）+ 4 端点 + 计费（**mbp 测试**：dedupe/export 的 hold-settle-failed 全分支、fileKeys 越权 400、checklist upsert 属主隔离）
- [ ] **Task C（web）**：两 tab 接线 + tsc/build
- [ ] **Task D**：/code-review 全修 → 双侧全绿 → commit → 部署 mbp

## 决策记录

- 审核表绑定：userId + 可空 projectId（有当前项目绑项目，无则用户级默认行）——与页面「独立工具」现状兼容且支持多项目。
- 查重结果落 `dedupe_runs` 审计（花了 100 分的操作要可追溯），暂不做历史列表 UI。
- Excel/PDF 导出、pdf 图片抽取、enterprise_template_id 母版：不做，留候选。
