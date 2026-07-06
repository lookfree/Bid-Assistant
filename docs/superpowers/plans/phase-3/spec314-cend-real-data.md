# C 端真实数据接入（projects 列表 / 资料库 / 真实积分展示） Implementation Plan (spec314)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消灭 C 端最后两个全 mock 页面（我的标书 projects、我的资料库 library），并把 content/present 页的演示积分/会员开关换成真实 `/api/membership` 数据；顺带修复 `GET /api/read/runs/:id` 的属主越权。

**Architecture:** 投标流水线（建项目→read→outline→content→review→present→export，含 SSE 与计费）后端已全通，前端经 `useStep`/`localStorage["bid.projectId"]` 双轨接入——本 spec 不动流水线与 agent 契约，只补三块「查询/CRUD」薄层：① `GET /api/projects` 列表（bid_projects 按用户分页）；② `library_items` 新表 + `/api/library` CRUD（附件复用既有 `/files` 三段式直传）；③ 前端 projects/library/content/present 四页接线。

**Tech Stack:** App API（Hono + Bun + Drizzle + zod + bun:test）；Web（Next.js 16 App Router + React 19 + shadcn）。

## Global Constraints

- 钱的铁律不受影响：本 spec 只**读**余额（`GET /api/membership`），不新增任何扣费/入账路径。
- 迁移手写 SQL + 手动追加 `drizzle/meta/_journal.json`（snapshot 脏，**禁止** drizzle-kit generate）。
- 集成测试在 mbp 跑：仓库根 `./test-on-mbp.sh test/<file>.test.ts`。
- 提交：英文 Conventional Commits、账号 `lookfree`、不加 Co-Authored-By。
- 函数 ≤80 行、文件 ≤800 行、关键方法有注释。

## 接口契约

### GET /api/projects（新增）
`?page=&pageSize=` → `pagedBody`：`items[]{id, name, status, currentStep, stepIndex, totalSteps, createdAt}`
- `name` = tenderFileKey 去 `uploads/<uid>/<uuid>/` 前缀的文件名（decodeURIComponent），缺省「未命名项目」
- `stepIndex` = currentStep 在 STEP_ORDER 的下标（`done` → totalSteps）；只见本人项目，createdAt 倒序
- 路由注册顺序：`GET /` 须在 `GET /:id` 之前

### /api/library（新增，全 camelCase，属主隔离）
- 表 `library_items`：id/userId(FK cascade)/category(CHECK: qualification|performance|personnel|finance|text|presentation)/title/meta/fields(jsonb [{label,value}])/expiry(text)/tags(jsonb string[])/attachments(jsonb [{fileId,name}])/body/createdAt/updatedAt；index(userId)；迁移 `0023_library_items.sql`
- `GET /api/library` → `{items[]}`（本人全部，倒序，不分页）
- `POST /api/library`（zod：category 枚举 + title min1，余可选）→ 201 整行
- `PUT /api/library/:id` → 整行；非本人 404
- `DELETE /api/library/:id` → `{ok}`；非本人 404
- 附件：前端走既有 `POST /files/presign-upload` → PUT 直传 → `POST /files/:id/complete`，存 `{fileId,name}`；下载走 `GET /files/:id/download-url`

### 安全修复
- `GET /api/read/runs/:id`：查询加 `userId` 属主过滤，查不到 404（原实现任意登录用户可读他人 run）。

## 前端接线

- `projects/page.tsx`：真实列表替换硬编码；统计从真实数据算；点卡片写 `bid.projectId` 后按 currentStep 跳（read→/read、outline→/outline、content→/content、review→/risk、present→/present、export|done→/content）；空态引导 /upload；搜索本地过滤。
- `library/page.tsx` + `lib/library.ts`：mock 条目下线，CRUD 走 `/api/library`；附件真上传/真下载；content/present 的「从资料库插入」改拉真实数据；分类常量/图标/expiryStatus 留前端。
- `content/page.tsx`、`present/page.tsx`：`DEMO_CREDIT_BALANCE`/本地 isMember 开关下线，挂载时 `fetchMembership()` 取真实余额与订阅（会员判定与 membership 页口径一致）。

## Tasks

- [x] **Task 1（api）**：GET /api/projects 列表 + test/projects-list.test.ts（只见本人/分页/name 解析/step 进度）
- [x] **Task 2（api）**：library_items 迁移 0023 + /api/library CRUD + test/library.test.ts（CRUD + A 建 B 不可见/改/删）
- [x] **Task 3（api）**：read runs 越权修复 + 用例
- [x] **Task 4（web)**：projects 页接列表
- [x] **Task 5（web)**：library 页接 CRUD + 附件直传
- [x] **Task 6（web)**：content/present 真实积分/会员
- [x] **Task 7**：mbp 全绿（api 套件 + web tsc/build）→ commit → 部署 mbp（rebuild api+web，迁移经 deploy 路径应用）

## 下一轮（spec315+ 候选，须动 agent 契约，本 spec 明确不做）

1. 招标原文全文分句（带 clauseId）返回——read/outline 左侧原文面板现恒为示例
2. 提纲编辑回写 / 正文编辑保存（编辑现仅本地 state；导出走 agent 侧状态，本地编辑不生效——契约级问题）
3. 单章 AI 改写指令通道（step 入参现固定 `STEP_TEXT`，无法带用户指令）
4. present 时长/模板参数透传（DeckSpec 支持 10/15/20 与模板，agent 侧写死 15）
5. 标书查重引擎（credit_cost.dedupe 口径已配，功能未实现）、终极审核表持久化+导出
6. 遗留收敛：`/api/read`（Phase 1）与 `/api/projects/:id/steps/read`（Phase 2）双读标路径并存；`GET /api/read/runs/:id` 结果未过 toCamel
7. 会员权益开关 → C 端操作权限打通（entitlement enforcement，依赖本轮之后的真实流量）
