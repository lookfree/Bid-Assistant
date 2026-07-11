# spec323 导出加固：真 TOC / 页码页眉 / 封面 / PDF 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 逐任务执行。

**Goal:** 导出的投标文档达到可交格式：真目录域（Word 打开可更新）、页脚页码（南瑞标要求逐页连续编码）、页眉项目名、像样的封面、签章占位；并产出 **PDF 版**（海警/南瑞电子版都要 PDF）。

**Architecture:** `render/docx.py` 用 python-docx 底层 OXML 注入 TOC 域（`w:fldSimple`/instrText `TOC \\o "1-3" \\h`）与页脚 PAGE 域；PDF 用 agent 镜像里的 LibreOffice（spec320 已装）`soffice --headless --convert-to pdf`。export 节点产 `bid.docx` + `bid.pdf` 双工件；App/Web 导出双下载。

## Global Constraints
- 作者 `lookfree <etwuman@126.com>`；禁止 Claude 相关内容。函数 ≤80 行。
- PDF 转换失败（soffice 缺失/超时 120s）→ 仅出 docx，工件清单不含 pdf，绝不因 PDF 失败废掉导出。
- docx 结构改动不破坏现有渲染测试（表格/标题/章节顺序断言不回归）。

### Task A: Agent — docx 加固 + PDF 转换 + export 双工件

**Files:**
- Modify: `services/agent/src/agent/render/docx.py`（封面居中大标题+项目信息块；TOC 域页；节设置：页眉=项目名、页脚=居中 PAGE 域页码；签章页保留）
- Create: `services/agent/src/agent/render/pdf.py`（`docx_to_pdf(docx_bytes) -> bytes | None`：tempdir + soffice subprocess，timeout 120s，失败返回 None + logger.warning）
- Modify: `nodes/export.py`（渲染 docx 后 best-effort 转 PDF，上传 `artifacts/<thread_id>/bid.pdf`，工件清单按实际产出）
- Test: `tests/`（docx OXML 含 TOC/PAGE 域断言（读 document.xml 字符串）；pdf.py mock subprocess 成功/失败/超时；export 节点 pdf None 时工件只有 docx）

**Interfaces:** export 节点输出 `state["export"]`（现状形状先读代码确认）增 `pdf_key`（可空）。App 端工件下载如按 key 约定（`artifacts/<thread>/bid.docx`），Task B 对齐。

- [ ] Task A 完成（pytest 绿 + 提交 `feat(agent): real TOC/page-number fields, styled cover, docx→pdf artifact`）

### Task B: App API + Web — 导出双下载

**Files:**
- Modify: App 导出工件 presign 路由（先 grep `bid.docx`/artifacts 找到现状），支持 pdf key（存在才给）
- Modify: `apps/web` 导出页：下载 Word + 下载 PDF 双按钮（pdf 无则隐藏/置灰）
- Test: App mbp 测试 + web build

- [ ] Task B 完成（提交 `feat(api,web): expose bid.pdf artifact download`）

## 验证口径
pytest/mbp/bun 全绿；归总 e2e：导出 docx 用 Word/WPS 打开——封面、可更新目录、页码页眉齐全;bid.pdf 可下载可读。

## 决策记录
- TOC 用域而非静态目录：页码只有排版引擎知道，域让 Word 打开时按 F9 更新（导出页文案提示一次）。
- PDF 由 LibreOffice 而非 python 库：保真度最高且镜像已有（spec320 装的）。
