# 资料库定向注入 + OCR 前置 + 缺证预警(Plan B) · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 人员/业绩条目按章确定性注入写手简报(不再赌 RAG);证照按招标要求定向插进具体章;OCR 前置存储支撑 alt;读标页缺证前置预警。

**Architecture:** App 保存资料库条目时后台 OCR 图片附件存 `ocrText`;content 步 run_input 增发 `library_refs`(人员/业绩文本条目)并给 credentials 带 ocrText;agent 简报按章关键词追加【资料库·人员/业绩】块(字符预算),流水线收尾 post-pass 按"招标要求×章定位×库存"三重命中在章尾追加证照占位图(缓存外,恒新鲜);web 读标页比对要求×库存出缺证预警。全部确定性代码投递,零新增计费。

**Tech Stack:** 既有三层栈;OCR 走现有 `ocrImage(dataUrl, maxChars=400)`(内网容器)。

**Spec:** `docs/superpowers/specs/2026-08-09-library-intelligence-design.md` ③④+基建节

## Global Constraints

- 证照词表字面量(双端同表,注释互指):`营业执照`/`资质证书`/`授权书`/`法定代表人身份证明`/`检测证书`/`许可证`
- 章关键词:人员块 `人员|团队|组织|简历`(终审修正:裸词「配置」误抓设备/系统配置类技术章,而「人员配置」已被「人员」覆盖);业绩块 `业绩|案例|经验|项目经历`(正则,标题+子项 label 命中任一即注入)
- 预算:注入块每块 ≤3000 字(截断注明条数);App 侧 personnel/performance 每类 ≤20 条;占位图 alt=`标题|ocrText前120字`(无 ocrText 则纯标题)
- 占位图形态与 Plan A 同:`data-file-id`/`data-object-key`/`alt` 无 src;`sys-creds` 章排除 post-pass
- **post-pass 产物不入章缓存**(缓存恒存模型原稿,证照插入每轮现算——库存变化即时生效)
- 零新增计费;OCR 后台 best-effort 失败静默;提交规范同前(作者/英文/无 Claude 字样;函数 ≤80 行)

---

### Task 1: App — OCR 前置基建

**Files:**
- Modify: `apps/api/src/routes/library.ts`(attachmentSchema 加字段;POST/PUT 保存成功后触发)
- Modify: `apps/api/src/db/schema/library.ts`($type 拓宽)+ `apps/web/lib/library.ts`(类型同步)
- Modify: `apps/api/src/storage/s3.ts`(加 `getObjectBytes(key): Promise<Uint8Array>`,照 getObjectHead 去 Range)
- Create: `apps/api/src/services/library-ocr.ts`
- Test: `apps/api/test/library-ocr.test.ts`

**Interfaces:**
- `LibraryAttachment` 增 `ocrText?: string`——**zod attachmentSchema 必须同步加**(`z.string().max(500).optional()`;sourceFileId 被剥的教训第 N 次,审查必核)
- `backfillAttachmentOcr(itemId: string, userId: string): Promise<void>`:查条目,对**图片扩展且无 ocrText** 的附件逐个:getObjectBytes → `data:image/<ext>;base64,…` → `ocrImage(dataUrl)` → 结果写回该附件的 ocrText(整列 jsonb 条件更新,带 userId 归属);任一失败跳过该附件继续;全程不抛
- routes/library.ts POST/PUT 成功响应**之后** `void backfillAttachmentOcr(row.id, userId)`(fire-and-forget,绝不阻塞保存)

- [ ] **Step 1: 失败测试**——①保存含图片附件的条目后(mock ocrImage 返回"统一社会信用代码91xx"),轮询/直调 backfill 后查回附件带 ocrText;②已有 ocrText 的附件不重复 OCR(mock 计数);③非图片附件跳过;④ocrImage 抛错→附件无 ocrText 且保存不受影响;⑤zod 往返:带 ocrText 的附件保存查回仍在
- [ ] **Step 2-4: 红→实现→绿 + typecheck**(测试直调 backfill 而非赌 fire-and-forget 时序)
- [ ] **Step 5: 提交** `feat(api): precompute attachment ocr text on library save`

---

### Task 2: App — content 步增发 library_refs + credentials 带 ocrText

**Files:**
- Modify: `apps/api/src/services/credentials.ts`(images 元素加 ocrText 透传;新增 libraryRefsRunInput)
- Modify: `apps/api/src/routes/projects.ts`(content 步 input 并入)
- Test: `apps/api/test/library-refs.test.ts`

**Interfaces:**
- `CredentialInput.images` 元素增 `ocrText?: string`(从附件透传;agent 侧宽容缺省)
- `libraryRefsRunInput(userId): Promise<{ library_refs?: { personnel: LibraryRefItem[]; performance: LibraryRefItem[] } }>`;`LibraryRefItem = { title: string; meta?: string; fields?: {label,value}[]; body?: string }`;每类按 updatedAt 降序**截前 20 条**;两类皆空回 `{}`(键不下发)
- content 步 input:`...(await libraryRefsRunInput(userId))` 与 credentials 并列

- [ ] **Step 1: 失败测试**——①有人员/业绩条目→input 带 library_refs 且形状字段齐;②超 20 条截断;③无条目不下发键;④credentials images 带 ocrText;⑤export 步仍不带这些键
- [ ] **Step 2-4: 红→实现→绿 + typecheck**
- [ ] **Step 5: 提交** `feat(api): send personnel and performance refs to the content step`

---

### Task 3: agent — 人员/业绩注入块(④)

**Files:**
- Modify: `services/agent/src/agent/agents/bidding_agent/nodes/content_pipeline.py`(_shared_blocks 构块;_chapter_brief 按章追加)
- Test: 追加 `services/agent/tests/agents/bidding_agent/test_content_pipeline.py`

**Interfaces:**
- `_shared_blocks` 增:`refs = run_input.get("library_refs") or {}` → `shared["personnel"]`/`shared["performance"]`:格式 `【资料库·人员】(供本章化用,不得整段照抄):\n- <title>|<meta>|<label:value;…>|<body>` 逐条;每块 ≤3000 字,超限截断并尾注"(另有 N 条未列出)";空则 ""
- `_chapter_brief`:章 title+各级子项 label 拼串,命中人员正则→append shared["personnel"],命中业绩正则→append shared["performance"](进 stable 部分——库存变化使相关章缓存失效,语义正确)
- 正则常量 `_PERSONNEL_RE`/`_PERFORMANCE_RE` 按 Global Constraints 字面量

- [ ] **Step 1: 失败测试**——①"项目团队与人员配置"章简报含人员块、"公司业绩"章含业绩块、"技术方案"章两者皆无;②预算截断(30 条长条目→≤3000 字+尾注);③无 library_refs 时所有简报与今天逐字节一致;④注入进 stable:库存变化→相关章缓存失效(键变),无关章不失效
- [ ] **Step 2-4: 红→实现→绿 + agent 全量**
- [ ] **Step 5: 提交** `feat(agent): inject personnel and performance refs into matching chapter briefs`

---

### Task 4: agent — 证照定向插章 post-pass(③)

**Files:**
- Create: `services/agent/src/agent/agents/bidding_agent/nodes/cert_placement.py`
- Modify: `services/agent/src/agent/agents/bidding_agent/nodes/content_pipeline.py`(run_content_pipeline 收尾接线)
- Test: `services/agent/tests/agents/bidding_agent/test_cert_placement.py`

**Interfaces:**
- `CERT_KEYWORDS = ("营业执照", "资质证书", "授权书", "法定代表人身份证明", "检测证书", "许可证")`
- `place_certificates(out: dict[str, str], state: dict) -> dict[str, str]`(纯函数,返回新 dict):对每个非 system 章——read 的 qualification/commercial 条目 title 命中词表某词 K,且该条目 clause_ids 经章子项 clause_ids 定位到本章(复用 `_collect_clause_ids` 的交集手法)→ 若 `run_input.credentials` 有条目 title 含 K:章尾 append `<p>【K】见下图：</p>` + 该条目逐图占位(alt=标题|ocrText 截 120,HTML 转义);若库无:append `<p>（待补充：K）</p>`;定位不到章或词不命中→不动(附录章兜底);同章同 K 只插一次
- 接线:`run_content_pipeline` 构建 `out` 后、missing 统计前:`out = place_certificates(out, state)`——**在缓存读写之外**,fresh/cached 章一律现算
- 构建全程零 LLM(纯字符串;审查专项)

- [ ] **Step 1: 失败测试**——①要求"提供营业执照"定位到资格章+库有"营业执照"条目→该章尾出现见下图+占位图(alt 带 ocr 摘要),其他章不动;②库无→(待补充:营业执照);③定位不到(条目无 clause 交集)→不插;④缓存命中章同样获得插图(两次 run,第二次 calls==0 仍带图);⑤sys-creds 章不被 post-pass 触碰;⑥同章双要求同词只插一次
- [ ] **Step 2-4: 红→实现→绿 + agent 全量**
- [ ] **Step 5: 提交** `feat(agent): place required certificates into located chapters after writing`

---

### Task 5: web — 读标页缺证预警

**Files:**
- Create: `apps/web/lib/cert-keywords.ts`(词表+纯函数;注释注明与 agent cert_placement.py 双端同表)
- Modify: `apps/web/app/(tool)/read/page.tsx`(读标完成态加预警条;组件形态抄该页既有提示条)
- Test: `apps/web/test/cert-warnings.test.ts`

**Interfaces:**
- `CERT_KEYWORDS`(同表);`missingCerts(categories: {key,items:{title}[]}[], credentialTitles: string[]): string[]`——qualification/commercial 条目 title 命中词 K 且 credentialTitles 无一含 K → 收集 K(去重,保持词表序)
- 接线:读标 done 后取 `export-preview`(已有 credentials titles)→ `missingCerts` 非空 → 预警条"招标要求提供:营业执照、检测证书——资料库未见,建议先到资料库上传",链接 /library;取不到 preview 静默不显示
- [ ] **Step 1-5: 纯函数红→绿(命中/库有不报/去重);typecheck+build;提交** `feat(web): warn missing certificates right after tender reading`

---

### Task 6: 终审(最强模型,含双端词表一致性/零 LLM 专项/缓存交互)→ 发版验收(**与 Plan A 同批,冻结待用户指令**)

验收清单(发版后):①资料库放人员+业绩条目→生成正文,人员配置章内容引用真实人名/资质,业绩章引用真实项目;②资格章尾出现"【营业执照】见下图"+图;③读标完成即见缺证预警(库空时);④删光资质→读标页预警+正文(待补充);⑤OCR:新传证照图,条目保存后稍候查附件 ocrText 非空,插图 alt 带识别文字
