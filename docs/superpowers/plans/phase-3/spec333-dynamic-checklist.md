# spec333 · 终极审核表按招标文件定制

## 背景与决策

终极审核表（`/risk` 审查页第三个 tab）此前是**前端写死的 36 条静态模板**（8 组 A–H）。不同招标文件要求不同，静态表要么缺项要么冗余。改为**按本招标文件的读标结论定制生成**；无招标文件（无读标结果）的项目回落默认 36。

用户拍板的口径：

- **模型生成**（非确定性映射）：读标结论 → 一次结构化 LLM 调用产分组核对项。
- **有招标文件（有读标结果）才动态，否则默认 36。**
- **随读标计费、不另扣分**：审核表是「读标（read=20，已付费）」这步的衍生产物，读标成功后生成并存，**不预扣不结算**；生成失败/无模型/无读标 → 回落默认 36，绝不反噬读标结果交付。
- **本模块去掉资料库联动**（原「资料库已具备/缺失」徽标与 `libraryMatch` 移除）。
- 数据源是**已存的读标结论**（`project_steps` step=read done 的 `result`），不重读原文、不碰读标那条脆弱的并行/续跑主链。

## 三层实现

### Agent 服务（money-blind）
- `agents/bidding_agent/schemas.py`：`ChecklistGen`（`groups: [{title, items:[str]}]`，`min_length=1`）。
- `agents/bidding_agent/prompts/checklist.py`：`CHECKLIST_GEN_SYSTEM_PROMPT`（分组、条目紧扣本标书数值/★项/红线/构成清单）。
- `agents/bidding_agent/checklist_gen.py`：`_slim_for_checklist`（白名单读标字段，带 `required_structure` + ★评分项名，裁 `source_quote`）+ `generate_checklist(ctx, read_result)`（`run_submit_agent` 一次结构化提交，同 outline 节点范式）。
- `models/gateway.py`：新增 `build_gateway(override)`——per-request 模型选择的统一构造点（`chapters.rewrite` 与 `generate.checklist` 共用）。
- `routes/generate.py`：`POST /generate/checklist`——建 gateway → 生成 → 组 id 服务端归一化为**数字序号**（1,2,3…；刻意避开前端默认表的 A–H 字母 id，防「默认表状态 key=A-0 在定制表生成后串档到同位条目」）→ `{groups}`；模型失败/未提交 → 502。

### App API（钱与鉴权的唯一权威层）
- 迁移 `0034_checklist_template.sql`：`project_checklists` 加可空 `template jsonb`（null=前端默认 36）。
- `services/agent-client.ts`：`generateChecklist(readResult, model)`（postSync 范式，model 有配置才下发）。
- `services/checklist-template.ts`：`ensureChecklistTemplate({userId, projectId})`——已存直返；否则读读标结果 → 解析后台模型 → 生成 → upsert 存 template。**best-effort、全程吞错、不扣费**；只写 template 列（items 由 PUT 单独维护，互不覆盖）。
- `routes/checklist.ts` GET：已存 template 直返；未存且有项目 → 懒生成一次；返回体加 `template`。
- `routes/projects.ts`：读标步成功收尾后 `void ensureChecklistTemplate(...).catch()` **fire-and-forget**，绝不阻塞/反噬读标交付与计费。

### 前端（apps/web）
- `lib/risk-api.ts`：`getChecklist` 返回 `{items, template}`；新增 `ChecklistGroupDef`。
- `app/(tool)/risk/checklist.tsx`：静态 `checklistGroups` → `DEFAULT_GROUPS`（回落）；`groups = template ?? DEFAULT_GROUPS` 驱动渲染/进度/导出；状态仍按 `组id-序号` key（template 冻结后 key 稳定）。**移除 `useLibrary`/`libraryMatch` 及资料库徽标列**（`libraryHit` 导出恒空）。

## 计费与铁律
- 审核表生成**不走 preDeduct/settle**，无新增 `credit_cost` 项——归属读标步已收的费。agent 只上报用量、不碰钱。
- 生成失败绝不抛错进读标/审查主链；无模型不静默回退默认模型（`getAgentModel` 返回 undefined → 回落默认 36，不占步位不预扣）。

## 测试
- Agent：`tests/agents/bidding_agent/test_checklist_gen.py`（8 例：生成/归一化/未提交抛错/slim/502）。全量 244 绿。
- App：`test/services/checklist-template.test.ts`（6 例：无读标/无模型/生成并持久化/生成一次/抛错吞错/空表）+ `test/checklist.test.ts` 追加 3 例（GET 懒生成/无项目不触发/已存直返）。27 绿。
- 前端：`tsc --noEmit` 通过。
