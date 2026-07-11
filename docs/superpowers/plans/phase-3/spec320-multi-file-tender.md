# spec320 多文件读标 + .doc/.xls 支持 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 逐任务执行。步骤用 `- [ ]`。

**Goal:** 一个项目可挂多个招标文件（采购公告/主文件/技术规范书/附件…），读标合并解析全部文件；支持 `.doc`/`.xls` 旧格式（服务端 LibreOffice 转换）。真实驱动案例：南瑞竞争性谈判标——资格在公告、评分在采购文件、逐条要求在技术规范书、废标清单在注意事项(.doc)，单文件读标必然读不全。

**Architecture:** 条款锚点体系保持 `sec-N-cM` 不变——多文件合并时**后续文件的章节号整体偏移**（文件1 章节 1..K，文件2 从 K+1 起），下游（web 锚点解码/RAG metas/提纲 clause_ids）零改动。`bid_projects.tenderFileKey` 保留（=第一个文件，向后兼容），新增 `tender_file_keys jsonb`。Agent run input 契约：`file_key`（首个，兼容）+ `files: [{key, name}]`（新）。

**Tech Stack:** Agent Python/uv（python-docx/pypdf/openpyxl + 新增 LibreOffice headless 转换）；App Hono/Bun/Drizzle；Web Next.js。

## Global Constraints

- 作者 `lookfree <etwuman@126.com>`；禁止任何 Claude 相关内容。Conventional Commits 英文。函数 ≤80 行、文件 ≤800 行。
- **单文件行为逐字节不变**：只传一个文件时，clauses id、prompt、doc_sections 与今天完全一致（合并函数对单文件是恒等变换）。
- .doc/.xls 转换失败 → 该文件降级跳过并在解析结果 meta 记 warning，不崩整个读标（其余文件照常）。
- LibreOffice 只进 agent 镜像（`libreoffice-writer` + `--no-install-recommends`）；本机无 soffice 时相关单测 mock/skip。

---

### Task A: Agent — 多文件解析合并 + .doc/.xls 转换 + read 节点多 key

**Files:**
- Create: `services/agent/src/agent/parsing/merge.py`
- Modify: `services/agent/src/agent/parsing/parsers.py`（.doc/.xls 经 LibreOffice 转 docx/xlsx 再解析）
- Modify: `services/agent/src/agent/agents/bidding_agent/state.py`（`files: list[dict] | None`）
- Modify: `services/agent/src/agent/agents/bidding_agent/nodes/read.py`（多文件解析→merge→注入 prompt 带文件名）
- Modify: `services/agent/Dockerfile`（apt 装 libreoffice-writer libreoffice-calc, no recommends）
- Test: `services/agent/tests/parsing/test_merge.py`、`tests/parsing/test_convert.py`、read 节点测试补多文件用例

**Interfaces:**
- `merge.merge_parsed(docs: list[tuple[str, ParsedDoc]]) -> tuple[list[dict], list[dict]]`
  返回 `(clauses, file_ranges)`。clauses=各文件 clauses 顺序拼接，文件 j≥2 的 `sec-{N}-c{M}` 的 N 加上前面文件的最大章节号偏移（正则重写 id）；单文件=恒等。`file_ranges=[{name, sec_from, sec_to}]`。
- `parsers.py`：`_DISPATCH` 增 `doc`/`xls` → `_convert_legacy(data, ext) -> (bytes, new_ext)`：写临时文件，`soffice --headless --convert-to docx|xlsx --outdir <tmp>`（subprocess, timeout 60s），读回转换产物再走 docx/xlsx 解析；soffice 不存在/转换失败 → 抛 `UnsupportedDocument`（调用方按文件降级）。
- read 节点：`state.get("files")` 非空 ⇒ 逐个 `read_and_parse(f["key"])`（失败文件跳过并 logger.warning），`merge_parsed` 合并；prompt 的条款注入前加一段文件清单（`文件1《name》=章节 sec_from..sec_to`）；`state["file_key"]` 路径保留（files 缺省时用，行为不变）。read 输出加 `doc_files: file_ranges`（additive，web 可忽略）。RAG 索引用合并后 clauses（现状逻辑不动）。

- [ ] Task A 完成（测试全绿 + 提交 `feat(agent): multi-file tender parsing with section-offset merge + legacy .doc/.xls conversion`）

### Task B: App API — 项目多文件 + run input 契约

**Files:**
- Modify: `apps/api/src/db/schema/`（bidProjects 加 `tenderFileKeys: jsonb`）+ `bun run db:generate` 出迁移
- Modify: `apps/api/src/routes/projects.ts`（POST / 接受 `fileKeys: string[]`（1..10，全部校验属主）或旧 `fileKey`；存两列；read 步 run input 加 `files:[{key,name}]`；GET 详情回 `fileKeys`）
- Modify: `apps/api/src/routes/read.ts`（bodySchema 接受 fileKeys 数组或 fileKey；input 带 files）
- Modify: `apps/api/src/services/files.ts` + web 上传 whitelist（Task C）：`SUPPORTED_EXTS` 增 `doc`/`xls`
- Test: `apps/api/test/`（建项目多 fileKeys 属主校验/两列落库/run input files 形状；单 fileKey 兼容不回归）

- [ ] Task B 完成（mbp 测试绿 + 提交 `feat(api): projects accept multiple tender files; pass files to agent read`）

### Task C: Web — 上传全部文件入项目

**Files:**
- Modify: `apps/web/app/(tool)/upload/page.tsx`（`SUPPORTED_EXTS` 增 doc/xls、accept 属性、startRead 传全部 done 文件的 fileKeys、文案）
- Modify: `apps/web/lib/project.ts`（createProject(fileKeys: string[])）
- Test: `bunx tsc --noEmit` + build

- [ ] Task C 完成（提交 `feat(web): send all uploaded tender files to project creation`）

## 验证口径
Agent pytest 全绿（转换用 mock；mbp 镜像构建后 soffice 真转一次）；App mbp bun test 绿；web build 绿。e2e 归总验收（spec325 后）：南瑞 4 文件（含 .doc）一次读标。

## 决策记录
- **章节偏移而非 id 前缀**：`f2-sec-N-cM` 会破坏 web 锚点解码与既有 clause_ids 语义；偏移让 id 格式不变、单文件恒等，下游零改动。
- **转换放 agent 而非 App**：解析本来就在 agent（Python），LibreOffice 同镜像还服务 spec323 的 docx→PDF。
- 上限 10 个文件/项目（防滥用）；xlsx 附件(登记表类)照常入列——解析出的表格并入 clauses 文本。
