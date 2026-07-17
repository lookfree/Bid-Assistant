# spec326 · 算法备案合规功能包 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 逐任务执行。Steps use checkbox (`- [ ]`) syntax.

**Goal:** 补齐算法备案自评估报告要求的五个系统功能（见 `docs/算法备案/11-备案差距与整改清单.md` 三.1-三.5）：① AI 生成内容显式提示标识（页面 + 导出弹窗 + 导出文件）；② 服务协议/隐私政策页 + 死链修复；③ 算法公示页；④ 反馈/投诉申诉入口（C 端提交 + 后台处理）；⑤ 生成输出敏感词检测记录。全部为备案图5/6/12/13/14/17 提供可截图的真实功能。

**Architecture:** 四端改动。**web**：新组件 `AiNotice`（固定文案，无关闭按钮）逐页插入五个结果页 + 导出弹窗加提示行；`(tool)` 组外新增 /terms /privacy /algorithm 三静态页，登录页死链与首页 footer 接上；`(tool)` 组内新增 /feedback 页（表单 + 本人历史），membership「联系客服」改指 /feedback。**App API**：新表 `feedback`（手写迁移 0028）+ C 端 `/api/feedback`（POST/GET，authMiddleware，日限 20 条）+ admin `/admin-api/feedback`（分页列表 + PATCH 处理，新权限 `feedback.read/write`，写操作记审计）。**admin**：新「反馈工单」菜单页（列表筛选 + 处理弹层）。**agent**：docx 末尾自动写入生成说明段（PDF 经 LibreOffice 转换自动继承）、pptx 结束页加小字提示（blank/master 两路径都盖）；`framework/content_safety.py` 敏感词扫描挂 `export_node`，命中经 `ctx.recorder.log_event` 落 `agent.agent_event_log`（best-effort，绝不挡导出）。

**Tech Stack:** apps/web（Next.js 16 App Router，原生 textarea/select——components/ui 只有 button/dropdown-menu/input）；apps/api（Hono+Drizzle+Zod，bun test 经 `./test-on-mbp.sh`）；apps/admin（shadcn Table/Card/Select 全套 + adminApi）；services/agent（python-docx/python-pptx，uv run pytest 纯函数离线）。

## Global Constraints

- **固定文案（报告§一(五)给定，逐字不可改）**：
  - 长版（页面横幅 / docx 说明段）：`本内容由智启元投标助手生成合成类算法辅助生成，仅供投标文件编制参考，请结合招标文件原文和企业实际情况复核确认后使用。`
  - 短版（导出弹窗 / pptx 结束页）：`本内容由 AI 辅助生成，仅供参考，请人工复核后使用`
- **页面标识系统自动添加、用户不可关闭**（无关闭按钮、无本地存储开关）——备案承诺。
- **导出产物韧性铁律**：AI 说明写入与敏感词扫描都不得引入新的失败路径——扫描/落库任何异常 try/except 吞掉记 warning，docx/pptx 渲染主流程行为不变；无命中不写事件。
- **money-blind 不变**：/api/feedback 免费（不扣积分不预扣）；agent 仍只上报。
- **迁移手写**：`drizzle/0028_feedback.sql`（CREATE TABLE IF NOT EXISTS + 内联 FK + 幂等索引，照抄 0025 范式）+ `drizzle/meta/_journal.json` 追加 `{idx:28, tag:"0028_feedback"}`；**严禁 `db:generate`**。schema 不用 pgEnum，用 `text().$type<Union>()` + 迁移里 CHECK。
- **公示页/协议页正文以报告承诺为准**，不夸大能力、不承诺中标；申诉渠道写「登录后进入 帮助与反馈（/feedback）」+ 客服邮箱常量（占位 `SUPPORT_EMAIL`，集中在一处待运营补充）；备案编号一行占位「备案编号：待备案通过后公示」。
- 提交英文 Conventional Commits、`lookfree <etwuman@126.com>`、无 Co-Authored-By；函数 ≤80 行、文件 ≤800 行；分支 `phase3/spec326-filing-compliance`，任务粒度提交。
- 验证：api `./test-on-mbp.sh`（必须 mbp 隧道）；agent `cd services/agent && uv run pytest`（渲染/扫描为纯函数离线）；web/admin `bun run typecheck` + `bun test test/`。

## 契约

### feedback 表（public schema，`src/db/schema/feedback.ts`，barrel 追加 export）

```ts
export const FEEDBACK_TYPES = ["content_error", "complaint", "billing", "suggestion", "other"] as const
export const FEEDBACK_STATUSES = ["pending", "processing", "resolved"] as const
// 列：id() PK / userId uuid FK users cascade / type text / projectId uuid FK bidProjects set null 可空
//    / content text notNull / contact text 可空 / status text default "pending" / reply text 可空
//    / handledBy text 可空（admin username，对齐审计口径）/ handledAt tz 可空 / createdAt()
// 索引：(status, createdAt) + (userId, createdAt)；迁移里对 type/status 加 CHECK IN (...)
```

### C 端 `/api/feedback`（`src/routes/feedback.ts` 工厂 `feedbackRoutes()`，挂 app.ts）

- `POST /`：zod `{type: enum(FEEDBACK_TYPES), content: string 1..2000, contact?: string ≤100, projectId?: uuid}` → 400 `invalid_input`；当日（服务器时区 UTC 起算即可）本人已提交 ≥20 条 → 429 `too_many_feedback`；成功 201 返回行。
- `GET /`：本人列表 `{items}`，createdAt desc，limit 50，含 status/reply（用户能看到处理结果——报告「合理期限内反馈用户」的承载）。
- 隔离：全部 where userId=getUserId(c)。

### admin `/admin-api/feedback`（`src/routes/admin/feedback.ts` 导出 `feedbackRouter`，挂 admin/index.ts `authed` 组）

- RBAC：`services/rbac.ts` PERMISSIONS 追加 `"feedback.read", "feedback.write"`；ROLE_PERMISSIONS：superadmin（spread 自动）、ops 和 support 两者都加（客服处理工单是本职，见决策记录 2）。
- `GET /?status=&page=&pageSize=`：`requirePermission("feedback.read")`，`parsePagination`/`pagedBody`，join users 带 nickname，createdAt desc。
- `PATCH /:id`：`requirePermission("feedback.write")`，zod `{status: enum(["processing","resolved"]), reply?: string ≤2000}` → 更新 + `handledBy=c.var.admin.username` + `handledAt=new Date()`；404 `not_found`；成功后 `writeAudit`（action `feedback.handle`，operator=username，target=id）。

### web（apps/web）

- `components/tool/ai-notice.tsx`：`AiNotice({className?})`——Info 图标 + 长版文案，样式 `mt-3 flex items-start gap-2 rounded-xl border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground`；无状态无关闭。插入点=标题卡之后：read/outline/risk（`max-w-7xl` 容器内）、content（`<header>` 后，加 `shrink-0`）、present（`shrink-0` 头部块内 header 后）。**仅主 return（结果态）插入**，加载/空态分支不插。
- `export-menu.tsx`：F9 提示行后、`{/* 积分预估 */}` 前插 `<p className="px-1 pt-1.5 text-[10px] text-muted-foreground">短版文案</p>`。
- 静态页（`(tool)` 组外，纯 server component，容器 `mx-auto max-w-3xl px-4 py-10` + 手写标题/段落排版，页尾放返回首页 Link）：
  - `app/terms/page.tsx` 用户协议：服务性质（AI 辅助工具/能力边界/不承诺中标）、账号与登录、用户上传内容合法性承诺（来源合法、已获授权、不含涉密与他人未授权个人信息）、AI 生成内容性质与人工复核义务（引长版文案）、积分计费与失败退款、禁止行为（诱导违规输出/批量滥用/绕计费）、知识产权与商业秘密、责任限制、协议变更与联系方式。
  - `app/privacy/page.tsx` 隐私政策：收集范围（手机号/验证码/账号标识/操作记录/上传文档）、处理目的（登录/项目/生成/计费/审计/客服）、第三方共享（大模型 API 仅推理必需文本片段，不含手机号/支付信息；短信服务商；支付服务商）、存储与安全（HTTPS/user_id 隔离/最小权限）、用户权利（查询/更正/删除/注销 → /feedback 渠道）、未成年人条款、政策变更。
  - `app/algorithm/page.tsx` 算法公示：算法名称「智启元投标助手生成合成类算法」、主体「上海安几科技有限公司」、机制机理（用户显式触发：上传→解析分块→结构化读标→RAG 检索→章节生成→审查→导出；不训练不微调、不构建画像、无推荐排序）、应用场景与目的、用户权益保障（显式触发/可编辑重写/失败退款/clause_id 溯源/生成标识）、申诉渠道、备案编号占位。
- `app/login/page.tsx` 303/307 行 `<a href="#">` → `<a href="/terms" target="_blank">` / `<a href="/privacy" target="_blank">`。
- `app/page.tsx` footer：加 `用户协议 / 隐私政策 / 算法公示` 三个 `<Link>`（`hover:text-foreground`，插在版权行旁）。
- `app/(tool)/feedback/page.tsx` + `lib/feedback-api.ts`（工厂 `createFeedbackApi(request)` + 绑 `api.request` 单例，类型 `FeedbackItem`）：表单（type 原生 select 五项中文标签、content 原生 textarea rows=5 maxLength 2000、contact 可选 Input）→ 提交成功 toast/内联提示并刷新列表；下方「我的反馈」列表（类型/时间/状态徽章/内容/官方回复）。membership 388 行 `<Link href="/">联系客服` → `href="/feedback"`；`components/tool/app-sidebar.tsx` nav 加「帮助与反馈」`/feedback`（照现有数组模式）。
- 测试：`test/feedback-api.test.ts`（fetchImpl 注入：POST body/路径、GET items、429 抛 ApiError code）。

### admin（apps/admin）

- `app/(admin)/feedback/page.tsx` 薄壳 → `components/admin/feedback/feedback-client.tsx`：状态 Select 筛选（全部/待处理/处理中/已解决）+ Table（时间/用户昵称/类型/内容摘要/状态/操作）+ 行点开处理弹层（全文 + reply textarea + 状态按钮「开始处理/标记解决」调 PATCH）+ `TablePagination`；toast 错误提示；模式照 ledger-client。
- `components/admin/app-sidebar.tsx` nav 追加 `{ title: "反馈工单", url: "/feedback", icon: MessageSquare }`（模型管理与系统权限之间）。
- `lib/admin-api.ts`：`feedback: { list: (p:{status?,page?,pageSize?}) => req<Paged<ApiFeedback>>(...), handle: (id, patch:{status,reply?}) => req<ApiFeedback>(...PATCH) }` + `ApiFeedback` 类型（snake→camel 不需要：admin-api 直接透传 API json，字段名与路由返回一致）。

### agent（services/agent）

1. **docx 生成说明段**：`render/docx.py` `render_docx` 签章页两行之后追加：`doc.add_paragraph()` + 一段长版文案（新辅助 `_add_ai_notice(doc)`：9pt、灰色 `RGBColor(0x88,0x88,0x88)`、居中）。PDF 经 `docx_to_pdf` 自动继承，pdf.py 不改。
2. **pptx 结束页提示**：`_render_end` 与 `_render_end_on_master` 各加一行底部小字 `_textbox(...)`（短版文案，size=10，muted 色，居中，y 位于强调条上方）——两条渲染路径都盖；测试断言两路径产物文本含短版文案。
3. **敏感词扫描**：新 `src/agent/framework/content_safety.py`：`load_words() -> frozenset[str]`（模块级缓存；路径 `settings.sensitive_words_path` 非空则读该文件，否则读包内 `framework/sensitive_words.txt`；每行一词、`#` 注释、空行跳过）+ `scan_text(text) -> dict[str,int]`（子串计数，忽略大小写英文；词库量级百内直扫够用）。词库初版覆盖暴恐/色情/赌博/毒品/涉政违法类明确违禁词几十条，文件头注释「运营按监管要求扩充；改词库无需改代码」。
4. **挂点**：`nodes/export.py` `export_node` 在 render_docx 之前对 `state["chapters"]` 全部值拼接 + `state.get("deck")` 的 `json.dumps(ensure_ascii=False)` 做一次 `scan_text`；命中非空 → `await asyncio.to_thread(ctx.recorder.log_event, ctx.run_id, ctx.agent_type, "content_flag", node="export", level="warn", data={"words": sorted(hits), "counts": hits}, thread_id=ctx.thread_id)`，整体 try/except 吞异常记 logger.warning。**不拦截不改文**（v1 记录供人工处置，对齐报告「识别→记录→人工处置」）。
5. **config**：`config.py` `Settings` 加 `sensitive_words_path: str | None = None`。

## 验证口径

- **api（./test-on-mbp.sh test/feedback.test.ts）**：POST 合法 201/非法 400/未登录 401；GET 仅见本人（A 建 B 查不见）；日限：直插 20 行后 POST → 429；admin GET 分页+status 筛选、finance → 403、support 可 PATCH；PATCH 更新 status/reply/handledBy 且 404 分支；处理后 audit-logs 可查到 `feedback.handle`。
- **agent（uv run pytest，离线）**：docx 产物文本含长版文案（照 test_docx_render 解 Document 断言）；pptx blank+master 两路径结束页含短版文案；scan_text 命中/不命中/注释行忽略；export_node 植入违禁词 → recorder.log_event 被调（mock ctx），recorder 抛错导出仍成功，无命中不调用。
- **web/admin**：`bun run typecheck` 全绿；`bun test test/`（web feedback-api 单测）；手测口径：登录页两链接可点开、首页 footer 三链接、五结果页横幅、导出弹窗提示行、/feedback 提交后 admin 工单页可见并处理、C 端刷新可见回复。
- **备案截图对照**：图5（结果页横幅）、图6（导出弹窗/docx 末尾说明）、图12（/feedback + admin 工单页）、图13（/terms /privacy）、图14（词库文件 + agent_event_log 的 content_flag 查询）、图17（/algorithm）。

## Tasks

- [x] **Task A（App API）**：feedback schema + 手写迁移 0028 + journal + rbac 权限 + C 端路由 + admin 路由 + 审计 + `./test-on-mbp.sh test/feedback.test.ts` 绿（提交 `feat(api): feedback table, user routes and admin handling with RBAC`）。
- [x] **Task B（web）**：AiNotice 组件 ×5 页 + 导出弹窗提示 + /terms /privacy /algorithm 三页 + 登录死链/首页 footer/membership 链接 + /feedback 页 + feedback-api 封装与单测 + typecheck 绿（提交 `feat(web): AI-generated notices, legal/disclosure pages and feedback entry`；终审补 `fix(web): add contact and appeal channel to terms page`）。
- [x] **Task C（admin）**：反馈工单页 + 侧栏项 + admin-api client + typecheck 绿（提交 `feat(admin): feedback ticket management page`）。
- [x] **Task D（agent）**：docx 说明段 + pptx 结束页提示（双路径）+ content_safety 模块与词库 + export_node 挂点 + Settings 字段 + pytest 绿（提交 `feat(agent): AI notice in exports and sensitive-word scan on delivery`）。
- [x] **Task E（验证收尾）**：四端门禁全绿（api 498/498、agent 164 离线、web 37/37、admin 36/36、typecheck 三包绿）→ 全分支终审 READY TO MERGE → 合并 main 推送 → docs 同步 mbp → **部署 mbp 开发环境**（用户 2026-07-17 明确要求；部署前查 `project_steps status='running'` 在途任务）。

## 决策记录

1. **AI 提示在导出文件里走「文档末尾说明段/结束页小字」而非每页页脚**：用户导出的 docx 是要真实提交给招标方的投标文件，每页页脚打 AI 标识会实质损害用户交付物；报告原文本就是「导出确认页面、导出文件页脚**或**文件说明页」三选一。取导出弹窗提示（不可跳过）+ 文件末尾说明段双保险，既满足「导出环节自动写入」承诺又不污染用户正文。用户定稿时可自行删除说明段——其人工复核义务已由协议与页面标识承载。
2. **support 角色获得 feedback.write**：现有口径 support 写操作全 403，但反馈工单处理正是客服本职；权限粒度到 `feedback.write` 不放开其它写权限，风险可控。
3. **敏感词 v1 只记录不拦截**：备案叙述是「识别与发现机制 + 人工处置」，拦截误伤（投标文本里「赌」「毒」类字面可能合法出现，如医药/安防标书）代价高于收益；记录进 `agent_event_log`（event_type=`content_flag`）即可支撑图14 台账查询与后续处置，拦截策略留候选。
4. **扫描挂 export_node 而非各生成节点**：读标/审查/述标是结构化 Pydantic 输出且无公共文本收口（`strip_document_shell` 只盖 content），export 是全部交付内容（chapters+deck）的唯一汇聚点，一次扫描全覆盖、`ctx.recorder` 现成、零侵入生成链路。已知取舍：用户在页面上看到中间结果早于导出扫描——v1 接受（内容默认仅自见，扩散点在导出）。
5. **反馈不做实时通知/工单状态机**：三态（待处理/处理中/已解决）+ reply 单字段即满足报告「记录受理时间、处理过程、处理结论」的最小闭环；站内信/邮件通知留候选。

## 本轮不做（候选池）

- 敏感词命中拦截/降级/账号处置自动化（记录已够 v1，处置走人工）。
- 违规样本台账后台页（线下台账文档即可支撑备案，见差距清单三.6）。
- 反馈附件上传、站内通知、处理时限 SLA 提醒。
- 输入侧（用户指令/上传文档）敏感词扫描。
- 协议/隐私政策版本化与重新同意流程。
