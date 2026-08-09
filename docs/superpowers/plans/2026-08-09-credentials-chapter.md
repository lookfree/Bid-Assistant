# 资质附录系统章节 + 审查恒定注记(Plan A) · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 资质附录从"导出时才冒出来"前置为生成期的系统章节(编辑器/审查/导出看同一份),导出层附录逻辑退役;渲染恒定项(签章页/AI 页)给审查一行注记——审查偏离归零。

**Architecture:** App 在 content 步 input 下发资质条目(带 fileId+key);agent 流水线收尾确定性构建「资格证明文件」章(轻量占位图,无字节)并把系统章写进图内 outline;App 收尾钩子把系统章同步进库里 outline result;render_docx 认 `data-object-key` 占位取字节;export 节点旧附录逻辑删除;web 解析占位图预签名、比对库存过期并一键刷新;review 输入加恒定项注记。

**Tech Stack:** 既有三层栈。测试 `uv run pytest` / `bun test`(api 带 `--env-file=../../.env.bidsaas.local`)。

**Spec:** `docs/superpowers/specs/2026-08-09-library-intelligence-design.md` ①② 两节(字面量以 spec 为准)

## Global Constraints

- 系统章字面量:`{id: "sys-creds", no: "附录", title: "资格证明文件", group: "business", system: true, sourced: false, items: []}`——App/agent 两处必须同形
- 占位图形态:`<img data-file-id="<fileId>" data-object-key="<key>" alt="<条目标题>" />`,**无 src 无字节**
- 章 HTML 形状:每条目 `<h3>标题</h3>` + 逐图占位;整章包在若干 `<p>` 里与既有章节 HTML 风格一致
- 重建语义(评审修正 2026-08-09):**每次 content 成功收尾都确定性重建附录章**(免费,始终最新);流水线对 `system` 章**结构性跳过**——不发模型调用、不进进度计数、不分字数预算、不打墓碑(state_overrides 每次回灌提纲步库结果,outline 带 sys-creds 是常态而非例外——评审实证);编辑期删除保持删除(下次 content 运行前有效)
- 计费红线:零新增计费分支;附录刷新免费;`shouldChargeExport`/`preDeduct` 等一行不碰(刷新走既有 PATCH 置脏路径即可)
- 提交规范:Conventional Commits、英文、作者 `lookfree <etwuman@126.com>`、无 Claude 字样;函数 ≤80 行;中文关键注释

---

### Task 1: App API — credentials 形状扩展与下发调整

**Files:**
- Modify: `apps/api/src/services/credentials.ts`(CredentialInput 形状)
- Modify: `apps/api/src/routes/projects.ts`(content 步下发;export 步退役下发)
- Test: `apps/api/test/credentials-shape.test.ts`(新建;样板抄 test/ 相邻 credentials/projects 测试)

**Interfaces:**
- Produces: `CredentialInput = { title: string; images: { fileId: string; key: string; name: string }[] }`(原 `images: string[]` 改对象数组);content 步 input 含 `credentials`(有货时);export 步 input **不再**含 credentials
- Consumes: 现有 `credentialsRunInput(userId)` 查询逻辑不变,只改映射输出

- [ ] **Step 1: 失败测试**——三段:①credentialsRunInput 返回对象数组(fileId/key/name 齐全,仍只收图片扩展、仍做属主二次校验);②content 步 input 带 credentials(mock createRun 捕获,样板抄 export-scope.test.ts);③export 步 input **无** credentials 键
- [ ] **Step 2: 确认失败**(`bun --env-file=../../.env.bidsaas.local test ./test/credentials-shape.test.ts`)
- [ ] **Step 3: 实现**——credentials.ts 映射改为 `{ fileId: a.fileId, key, name: a.name }`;projects.ts input 组装:content 步加 `...(await exportCredentials(userId))`,export 步移除该 spread(export_scope 透传保留)
- [ ] **Step 4: 通过 + `bun run typecheck`**(注意 export-preview 端点消费同一函数,imageCount 取 `images.length` 不变)
- [ ] **Step 5: 提交** `feat(api): credentials carry fileId+key and move to the content step`

---

### Task 2: agent — 附录章构建器 + 流水线接线

**Files:**
- Create: `services/agent/src/agent/agents/bidding_agent/nodes/credentials_chapter.py`
- Modify: `services/agent/src/agent/agents/bidding_agent/nodes/content.py`(content_node 收尾)
- Test: `services/agent/tests/agents/bidding_agent/test_credentials_chapter.py`(新建)

**Interfaces:**
- Produces:
  - `SYS_CREDS_ID = "sys-creds"`;`SYS_CREDS_CHAPTER = {"id": SYS_CREDS_ID, "no": "附录", "title": "资格证明文件", "group": "business", "system": True, "sourced": False, "items": []}`
  - `build_credentials_chapter(credentials: list[dict]) -> str`(HTML;空列表返回 "")
  - `append_credentials_chapter(state: dict, chapters: dict) -> dict | None`——run_input 有 credentials、outline 无 sys-creds、chapters 无 sys-creds 时:返回 `{"outline": 追加了系统章的新 outline, "chapters": {**chapters, "sys-creds": html}}`;否则 None(不动)
- Consumes: content_node 现有返回(chapters+墓碑);state.outline 为整体覆盖通道(返回 outline 键即覆盖图内状态)

- [ ] **Step 1: 失败测试**——①有 credentials 构建:HTML 含 `<h3>营业执照</h3>` 与 `data-file-id`/`data-object-key`/`alt`,不含 base64/src;②无 credentials → content_node 返回不含 outline 键、chapters 无 sys-creds;③同代重试(outline 已含 sys-creds)不重建不覆盖;④重新生成(传入 outline 无 sys-creds)重建;⑤墓碑逻辑不给 sys-creds 打 None(outline 追加后 ids 含它且 chapters 有它)
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**——content_node 在 `_log_length_telemetry` 后调 `append_credentials_chapter`;有返回则合并进节点输出(outline 覆盖+chapters 并入,墓碑计算用**追加后的** outline ids)
- [ ] **Step 4: 通过 + agent 全量**
- [ ] **Step 5: 提交** `feat(agent): build credentials appendix as a system chapter at content time`

---

### Task 3: agent — render_docx 占位图取字节 + export 附录退役

**Files:**
- Modify: `services/agent/src/agent/agents/bidding_agent/render/docx.py`(图片分支)
- Modify: `services/agent/src/agent/agents/bidding_agent/nodes/export.py`(删 `_fetch_credentials`/credentials 渲染参数)
- Test: 追加 `test_docx_render.py` / 修改 `test_export_node.py`

**Interfaces:**
- Produces: `render_docx` 遇 `<img data-object-key="…">`(无 data: src)→ 经新参 `fetch_object: Callable[[str], bytes | None] | None` 取字节 add_picture;取不到/回 None → 既有"(图片加载失败:…)"占位行。export 节点渲染前构造 `fetch_object = lambda key: read_bytes(key)`(同步,丢线程池由外层 to_thread 包渲染整体,与现状一致)
- Consumes: `storage_read.read_bytes`;credentials 参数从 render_docx 移除(附录内容已在 chapters 里)

- [ ] **Step 1: 失败测试**——①chapters 含占位图 + fake fetch_object 返回 PNG 字节 → docx 含图(用该文件既有断言手法);②fetch 回 None → 占位行;③export_node 不再向 render_docx 传 credentials(捕参断言),`_fetch_credentials` 已删除(import 报错即证)
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**(渲染分支加在现有 `data:image/` 分支旁;export.py 删函数与调用;credentials 相关注释同步清)
- [ ] **Step 4: 通过 + agent 全量**
- [ ] **Step 5: 提交** `feat(agent): render placeholder images from storage and retire export-time appendix`

---

### Task 4: App API — outline 同步钩子 + 附录刷新端点

**Files:**
- Modify: `apps/api/src/services/step-finalize.ts`(content 成功收尾处)
- Modify: `apps/api/src/routes/projects.ts`(新端点)
- Create: `apps/api/src/services/credentials-chapter.ts`(App 侧同形构建,含系统章字面量与 HTML 构建——与 agent 侧同形,双端各自持有确定性实现)
- Test: `apps/api/test/credentials-chapter.test.ts`

**Interfaces:**
- Produces:
  - `buildCredentialsChapterHtml(credentials: CredentialInput[]): string`(与 agent 侧 HTML 同形——占位图三属性同名)
  - content 收尾钩子:chapters 含 `sys-creds` 且库里 outline result 无该 id → outline result 原子追加系统章字面量(幂等,条件更新)。**注意(评审约束)**:库里 outline 带 sys-creds 后,后续每次 content 触发都会经 state_overrides 回灌——agent 侧靠"system 章跳过+恒重建"消化,本钩子无需感知代数
  - `POST /projects/:id/refresh-credentials-appendix`:归属校验 → 现查 credentialsRunInput → 重建 HTML → 更新 content result 的 `sys-creds` 键(走既有 PATCH content 同路径含置脏)+ outline 无则补章;无资质条目时 `409 {error:"no_credentials"}`;返回 `{html}` 供前端就地更新
- Consumes: Task 1 的 CredentialInput;现有 content result PATCH/置脏机制(读它的实现照抄同路径,不绕过 markExportDirty)

- [ ] **Step 1: 失败测试**——①钩子:mock 收尾输入含 sys-creds → outline result 多出系统章;outline 已有则不重复;chapters 无 sys-creds 不动;②刷新端点:200 返回 html 且 content result 更新+export 置脏;无资质 409;他人项目 404
- [ ] **Step 2: 确认失败**
- [ ] **Step 3-4: 实现、通过、typecheck**
- [ ] **Step 5: 提交** `feat(api): sync system chapter into outline and add appendix refresh`

---

### Task 5: web — 占位图解析 + 过期提示 + 刷新按钮

**Files:**
- Create: `apps/web/lib/credentials-appendix.ts`(纯函数)
- Modify: `apps/web/app/(tool)/content/page.tsx` 及章节渲染处(占位图 src 解析;附录过期条)
- Test: `apps/web/test/credentials-appendix.test.ts`

**Interfaces:**
- Produces(纯函数,测试覆盖):
  - `placeholderFileIds(html: string): string[]`(抠 `data-file-id`)
  - `appendixStale(chapterFileIds: string[], libraryFileIds: string[]): boolean`(集合不等即过期)
- 接线:章节渲染后对 `img[data-file-id]:not([src])` 逐个调既有预签名下载接口填 src(读 lib/files.ts 现有下载函数签名照用);sys-creds 章存在时取 export-preview 库存(imageCount 不够,需 fileId——**export-preview 响应再扩 `credential_file_ids: string[]`**,在 Task 4 顺带加上并测);过期 → 附录章顶部横条"资料库资质已更新 [刷新附录]" → 调 Task 4 端点,成功后就地替换该章 HTML
- [ ] **Step 1-5: 测试先红后绿(纯函数);typecheck+build 守护接线;提交** `feat(web): resolve placeholder images and refresh stale appendix`

(注意:export-preview 扩展字段写进 Task 4 的实现与测试;本任务只消费)

---

### Task 6: agent — 审查恒定项注记

**Files:**
- Modify: `services/agent/src/agent/agents/bidding_agent/nodes/review.py`(payload 组装处)与 `prompts/review.py`(若规则文案放提示词)
- Test: 追加 `services/agent/tests/agents/bidding_agent/test_review_node.py`(或该目录既有 review 测试文件,先找到再追加)

**Interfaces:**
- Produces: review 模型输入追加固定段:"【渲染恒定项】导出时将恒定附加:封面、目录、投标人承诺与签章页、AI 生成说明页——招标构成要求命中上述项时判「已具备(导出恒定附加)」,不判缺失。"
- [ ] **Step 1: 失败测试**——review 消息含该段(submit_gateway 捕获,样板抄 test_category_injection 的 review 测试);既有 review 测试零破坏
- [ ] **Step 2-4: 红→实现→绿+全量**
- [ ] **Step 5: 提交** `feat(agent): review is told about render-time constant sections`

---

### Task 7: 发版 230 + 实机验收(空档;web 走 mbp amd64)

- [ ] 发版(api/agent/web)
- [ ] 验收:①资料库有资质 → 生成正文后编辑器出现「附录·资格证明文件」章,图片可见;②审查不再报"缺营业执照"类资格缺失;③导出全量/商务册含附录(与编辑器一致),技术册不含;④库里加一张证照 → 附录章顶部出现刷新条 → 点刷新图进来;⑤删附录章正文重导 → 不复活;重新生成正文 → 复活;⑥招标构成要求"签章页"时审查不判缺
