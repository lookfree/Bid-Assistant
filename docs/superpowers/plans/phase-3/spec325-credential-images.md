# spec325 资质证照图片入库 + 导出插入 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 逐任务执行。

**Goal:** 资料库「资质」条目可挂证照图片附件；导出投标文档时自动生成**「资格证明文件」附录**——逐条目插入证照图片页,免去用户导出后手工拼图。

**Architecture:** 资料库 attachments 机制已有（`{fileId,name}[]` 引用 project_files）。App 在 export 步 run_input 下发 `credentials: [{title, images: [minio_key...]}]`（取用户 library category=qualification 且带图片附件的条目）；agent export 渲染 docx 时 best-effort 追加附录（MinIO 取图 → add_picture）。无 credentials ⇒ 文档与今天一致。

## Global Constraints
- 作者 `lookfree <etwuman@126.com>`；禁止 Claude 相关内容。函数 ≤80 行。
- 图片逐张 best-effort：取图/插图失败 → 该图占位一行「（图片加载失败：name）」,绝不废导出。
- 只认图片扩展 png/jpg/jpeg（pdf 附件跳过——docx 无法内嵌 pdf）。
- 上传白名单扩 png/jpg/jpeg 不影响招标文件流（web 上传页有自己的前端白名单,agent 解析器对图片抛 UnsupportedDocument）。

### Task A: Agent — 导出附录渲染

**Files:** `render/docx.py`（`_append_credentials(doc, credentials, fetch)`：分页符 + Heading1「资格证明文件」+ 每条目 Heading2 title + 逐图 add_picture(width=Inches(6))，fetch 失败/坏图占位段落）；`nodes/export.py`（`run_input.credentials` 非空时传入 render_docx，用 `parsing/storage_read.read_bytes` 作 fetch（asyncio.to_thread 或在 render 前预取字节）；空 ⇒ 渲染调用与今天一致）；测试（fake fetch 两态：正常插图（document.xml 或 media 计数断言）/ 抛错占位；无 credentials 字节级一致）。

- [ ] Task A（提交 `feat(agent): credential images appendix in exported docx`）

### Task B: App API + Web — credentials 下发 + 图片附件上传

**Files:**
- `apps/api/src/services/files.ts`：SUPPORTED_EXTS 增 png/jpg/jpeg（contentType 对应处理）。
- `apps/api/src/routes/projects.ts`：export 步 run 创建时查询该用户 libraryItems（category='qualification' 且 attachments 非空）→ 解析 attachments 的 fileId → project_files 取 key，仅保留图片扩展 → `run_input.credentials=[{title, images:[key...]}]`（无则不带键）。
- `apps/web/app/(tool)/library/page.tsx` + `lib/library.ts`：资质条目编辑处支持上传图片附件（复用既有 presign 上传流,accept image/*;若页面已有附件上传 UI 则仅放宽 accept）。
- 测试：export run_input 含 credentials 形状（mock capture）/ 无资质条目不带键；png presign 通过;web tsc+build。

- [ ] Task B（提交 `feat(api,web): credential image attachments flow into export run input`）

## 验证口径
agent/mbp/web 三门禁绿。e2e：资料库建「营业执照」资质条目挂 png → 导出 docx 末尾出现资格证明文件附录含该图。

## 决策记录
- credentials 由 App 查询下发而非 agent 直查库：agent 对业务库（public schema）无感知,保持边界。
- 附录固定追加在签章页之前;是否按 required_structure 决定放置位置留作后续（v1 恒附录）。
