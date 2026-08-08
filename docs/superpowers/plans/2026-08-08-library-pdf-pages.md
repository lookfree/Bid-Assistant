# 资料库 PDF 一键转页图 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 资料库条目里的证书类小 PDF(≤5 页)可由用户点按钮转成页图附件,此后插入标书正文与普通图片零差别。

**Architecture:** 三层各一小块:agent 加同步工具路由(pypdfium2 渲染,MinIO 读写走现有 `storage` 单例);App API 加带鉴权的中转端点并为页图建 `project_files` 记录;前端在条目编辑器附件行加「转为图片」按钮,页图作为普通附件(带 `sourceFileId`)进入现有插入链路,插入层唯一新规则是"已转出页图的 PDF 不再按文件名列出"。

**Tech Stack:** FastAPI + pypdfium2(agent,均已有);Hono + Drizzle(App API);React(web)。测试:`uv run pytest`(agent)、`bun test`(api/web)。

**Spec:** `docs/superpowers/specs/2026-08-08-library-pdf-pages-design.md`(数字与错误码以 spec 为准)

## Global Constraints

- 页数上限 **5**;渲染宽 **1600px** PNG;PDF 大小上限 **20MB**;App→agent 超时 **30s**
- 错误码字面量:`not_pdf` / `too_large` / `too_many_pages` / `unrenderable` / `agent_unavailable`
- 页图命名:`<原文件名去 .pdf>-第N页.png`;MinIO 键:`derived/<uuid>/page-N.png`
- 计费零涉及(免费功能,不碰积分);agent 依旧 money-blind
- 提交规范:Conventional Commits、英文、作者 `lookfree <etwuman@126.com>`、不含任何 Claude 字样
- 函数 ≤80 行;关键方法中文注释;沿用各文件既有风格

---

### Task 1: agent 渲染函数 `render_pdf_pages`

**Files:**
- Modify: `services/agent/src/agent/agents/bidding_agent/render/preview.py`(文件尾追加)
- Test: `services/agent/tests/agents/bidding_agent/test_pdf_pages_render.py`(新建)

**Interfaces:**
- Produces: `render_pdf_pages(pdf_bytes: bytes, max_pages: int = 5, width_px: int = 1600) -> list[tuple[bytes, int, int]]`(每页 `(png_bytes, width, height)`,按页序);超页数抛 `TooManyPages`,加密/损坏抛 `UnrenderablePdf`(两个异常类同文件定义)
- Consumes: 现有 `pypdfium2`(已是依赖,`render_deck_previews` 在用)

- [ ] **Step 1: 写失败测试**

```python
# services/agent/tests/agents/bidding_agent/test_pdf_pages_render.py
"""资料库 PDF 一键转页图(spec 2026-08-08):渲染层。
用 pypdfium2 现场造 PDF,不往仓库塞二进制夹具。"""
import pypdfium2 as pdfium
import pytest

from agent.agents.bidding_agent.render.preview import (
    TooManyPages, UnrenderablePdf, render_pdf_pages)


def _pdf_with_pages(n: int) -> bytes:
    doc = pdfium.PdfDocument.new()
    for _ in range(n):
        doc.new_page(595, 842)  # A4 点阵尺寸
    import io
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def test_renders_each_page_as_png_at_target_width():
    pages = render_pdf_pages(_pdf_with_pages(2))
    assert len(pages) == 2
    for png, w, h in pages:
        assert png[:8] == b"\x89PNG\r\n\x1a\n", "不是 PNG 字节"
        assert w == 1600 and h > w, "A4 竖版按宽 1600 等比,高应大于宽"


def test_more_than_max_pages_is_rejected_before_rendering():
    with pytest.raises(TooManyPages):
        render_pdf_pages(_pdf_with_pages(6))


def test_garbage_bytes_raise_unrenderable():
    with pytest.raises(UnrenderablePdf):
        render_pdf_pages(b"not a pdf at all")
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd services/agent && uv run pytest tests/agents/bidding_agent/test_pdf_pages_render.py -q`
Expected: FAIL,`ImportError: cannot import name 'render_pdf_pages'`

- [ ] **Step 3: 实现(preview.py 尾部追加)**

```python
# ---- 资料库 PDF 转页图(spec 2026-08-08-library-pdf-pages) ----

_PDF_PAGE_MAX = 5          # 只服务证书类小 PDF;超页数明示"暂不支持",不做选页界面(用户拍板)
_PDF_PAGE_WIDTH_PX = 1600  # 证书文字对 OCR 可读;前端插入时自会压到 1200 JPEG 内嵌


class TooManyPages(Exception):
    """页数超上限——路由层映射为 422 too_many_pages。"""


class UnrenderablePdf(Exception):
    """加密/损坏/非 PDF——路由层映射为 422 unrenderable。"""


def render_pdf_pages(pdf_bytes: bytes, max_pages: int = _PDF_PAGE_MAX,
                     width_px: int = _PDF_PAGE_WIDTH_PX) -> list[tuple[bytes, int, int]]:
    """PDF → 每页一张 PNG(按页序)。返回 [(png_bytes, width, height)]。
    渲染循环与 render_deck_previews 同源:按宽等比缩放、PIL 存 PNG。
    先查页数再渲染——6 页的文件不该白渲 5 页才发现超限。"""
    import io

    import pypdfium2 as pdfium

    try:
        doc = pdfium.PdfDocument(pdf_bytes)
    except Exception as e:  # noqa: BLE001 pdfium 对加密/损坏抛自家异常,统一归为不可渲染
        raise UnrenderablePdf(str(e)) from e
    try:
        if len(doc) > max_pages:
            raise TooManyPages(f"{len(doc)} pages > {max_pages}")
        out: list[tuple[bytes, int, int]] = []
        for i in range(len(doc)):
            page = doc[i]
            scale = width_px / max(page.get_width(), 1)
            pil = page.render(scale=scale).to_pil()
            buf = io.BytesIO()
            pil.save(buf, "PNG", optimize=True)
            out.append((buf.getvalue(), pil.width, pil.height))
        return out
    finally:
        doc.close()
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd services/agent && uv run pytest tests/agents/bidding_agent/test_pdf_pages_render.py -q`
Expected: 3 passed

- [ ] **Step 5: 提交**

```bash
git add services/agent/src/agent/agents/bidding_agent/render/preview.py services/agent/tests/agents/bidding_agent/test_pdf_pages_render.py
git -c user.name=lookfree -c user.email=etwuman@126.com commit -m "feat(agent): render pdf pages to png for library attachments"
```

---

### Task 2: agent 路由 `POST /tools/pdf-pages`

**Files:**
- Create: `services/agent/src/agent/routes/pdf_pages.py`
- Modify: `services/agent/src/agent/app.py`(import + include_router,紧挨 checklist_router 两处各加一行)
- Test: `services/agent/tests/test_pdf_pages_route.py`(新建)

**Interfaces:**
- Consumes: Task 1 的 `render_pdf_pages/TooManyPages/UnrenderablePdf`;现有 `agent.parsing.storage_read.storage`(`async read_bytes(key)` / `async put_bytes(key, data, content_type)`)
- Produces: `POST /tools/pdf-pages` 入参 `{key: str}`;成功 `200 {"pages": [{"key": str, "width": int, "height": int}]}`;业务失败 `422 {"error": "too_many_pages" | "unrenderable"}`。页键:`derived/<uuid4>/page-<N>.png`(N 从 1 起)

- [ ] **Step 1: 写失败测试**

```python
# services/agent/tests/test_pdf_pages_route.py
"""spec 2026-08-08-library-pdf-pages:agent 工具路由(mock storage,不连 MinIO)。"""
import pytest

from agent.routes import pdf_pages as mod
from agent.routes.pdf_pages import PdfPagesBody, pdf_pages


class _Storage:
    def __init__(self, pdf: bytes):
        self.pdf = pdf
        self.puts: list[tuple[str, bytes, str]] = []

    async def read_bytes(self, key):
        return self.pdf

    async def put_bytes(self, key, data, content_type="application/octet-stream"):
        self.puts.append((key, data, content_type))


def _pdf_with_pages(n: int) -> bytes:
    import io

    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument.new()
    for _ in range(n):
        doc.new_page(595, 842)
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


async def test_renders_uploads_and_returns_page_keys(monkeypatch):
    store = _Storage(_pdf_with_pages(2))
    monkeypatch.setattr(mod, "storage", store)
    resp = await pdf_pages(PdfPagesBody(key="uploads/u1/f1/cert.pdf"))
    assert [p["key"] for p in resp["pages"]] == [t[0] for t in store.puts]
    assert len(resp["pages"]) == 2
    assert all(k.startswith("derived/") and k.endswith(".png") for k, _, _ in
               [(p["key"], 0, 0) for p in resp["pages"]])
    assert all(ct == "image/png" for _, _, ct in store.puts)
    assert resp["pages"][0]["key"].endswith("page-1.png")
    assert resp["pages"][0]["width"] == 1600 and resp["pages"][0]["height"] > 1600


async def test_too_many_pages_is_422(monkeypatch):
    from fastapi.responses import JSONResponse
    store = _Storage(_pdf_with_pages(6))
    monkeypatch.setattr(mod, "storage", store)
    resp = await pdf_pages(PdfPagesBody(key="uploads/u1/f1/manual.pdf"))
    assert isinstance(resp, JSONResponse) and resp.status_code == 422
    assert b"too_many_pages" in resp.body
    assert store.puts == [], "超页数不该有任何对象写入"


async def test_unrenderable_is_422(monkeypatch):
    from fastapi.responses import JSONResponse
    store = _Storage(b"broken bytes")
    monkeypatch.setattr(mod, "storage", store)
    resp = await pdf_pages(PdfPagesBody(key="uploads/u1/f1/broken.pdf"))
    assert isinstance(resp, JSONResponse) and resp.status_code == 422
    assert b"unrenderable" in resp.body


def test_router_is_mounted():
    """接线必须是真的(本项目"写了但没接上"翻过多次车)。"""
    from agent.app import create_app
    paths = {r.path for r in create_app().routes}
    assert "/tools/pdf-pages" in paths
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd services/agent && uv run pytest tests/test_pdf_pages_route.py -q`
Expected: FAIL,`ModuleNotFoundError: No module named 'agent.routes.pdf_pages'`

- [ ] **Step 3: 实现路由**

```python
# services/agent/src/agent/routes/pdf_pages.py
"""资料库 PDF 转页图(spec 2026-08-08-library-pdf-pages)。

同步工具路由(参照 routes/chapters.py 的形态):App API 中转调用,agent 只做
"MinIO 取 PDF → 渲染 → 页图写回 MinIO",不建文件记录、不碰计费(money-blind)。
"""
from __future__ import annotations

import asyncio
import uuid

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from agent.agents.bidding_agent.render.preview import (
    TooManyPages, UnrenderablePdf, render_pdf_pages)
from agent.parsing.storage_read import storage

router = APIRouter()


class PdfPagesBody(BaseModel):
    key: str          # MinIO 对象键(App API 已做归属校验,这里只管渲染)


@router.post("/tools/pdf-pages")
async def pdf_pages(body: PdfPagesBody):
    """PDF → 逐页 PNG 写回 MinIO(derived/<uuid>/page-N.png),返回页键与尺寸。
    渲染是 CPU 活,丢线程池,别卡事件循环(本进程还serving改写/审核表)。"""
    pdf = await storage.read_bytes(body.key)
    try:
        pages = await asyncio.to_thread(render_pdf_pages, pdf)
    except TooManyPages:
        return JSONResponse({"error": "too_many_pages"}, status_code=422)
    except UnrenderablePdf:
        return JSONResponse({"error": "unrenderable"}, status_code=422)
    batch = uuid.uuid4()
    out = []
    for i, (png, w, h) in enumerate(pages, start=1):
        key = f"derived/{batch}/page-{i}.png"
        await storage.put_bytes(key, png, content_type="image/png")
        out.append({"key": key, "width": w, "height": h})
    return {"pages": out}
```

`services/agent/src/agent/app.py` 两处各加一行(紧挨 checklist 的同款位置):

```python
from agent.routes.pdf_pages import router as pdf_pages_router
```
```python
    app.include_router(pdf_pages_router)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd services/agent && uv run pytest tests/test_pdf_pages_route.py -q`
Expected: 5 passed

- [ ] **Step 5: 全量回归**

Run: `cd services/agent && uv run pytest tests -q`
Expected: 全绿(基线 773 passed, 1 skipped 上下)

- [ ] **Step 6: 提交**

```bash
git add services/agent/src/agent/routes/pdf_pages.py services/agent/src/agent/app.py services/agent/tests/test_pdf_pages_route.py
git -c user.name=lookfree -c user.email=etwuman@126.com commit -m "feat(agent): pdf-pages tool route renders pdf into derived png objects"
```

---

### Task 3: App API 端点 `POST /files/:id/pdf-pages`

**Files:**
- Modify: `apps/api/src/services/files.ts`(尾部追加 service 函数与错误类)
- Modify: `apps/api/src/routes/files.ts`(追加路由;import 补两个名字)
- Test: `apps/api/test/files-pdf-pages.test.ts`(新建;参照现有 test 的 db/auth 手法——先读 `apps/api/test/files.test.ts` 或相邻文件抄它的建用户/登录/建文件行套路)

**Interfaces:**
- Consumes: Task 2 的 agent 端点(经 `getEnv().AGENT_BASE_URL`);现有 `ownFile(fileId, userId)`、`projectFiles`、`getDb()`、`bucket()`
- Produces: `POST /files/:id/pdf-pages` → `200 {pages: [{fileId, name}]}`;`400 {error:"not_pdf"}` / `413 {error:"too_large"}` / `422 {error:"too_many_pages"|"unrenderable"}` / `502 {error:"agent_unavailable"}`。service 签名:`convertPdfToPages(fileId, userId, callAgent = agentPdfPages)`(callAgent 可注入,测试不起 agent)

- [ ] **Step 1: 写失败测试**

```typescript
// apps/api/test/files-pdf-pages.test.ts
// spec 2026-08-08-library-pdf-pages:中转端点。agent 调用可注入,测试永不外呼。
// 【按仓库现状抄】建用户/建 uploaded 文件行/带 auth 调路由的样板,与相邻 files 测试同款。
import { describe, expect, test } from "bun:test"
import {
  AgentUnavailableError,
  PdfPagesRejectedError,
  convertPdfToPages,
} from "../src/services/files"
// …(此处按仓库既有测试样板 import 建库/建用户帮助函数)

describe("convertPdfToPages", () => {
  test("成功:为每页建 uploaded 文件记录,归属同原文件,名字带页序", async () => {
    const { userId, fileId } = await makeUploadedPdf("检测证书.pdf")   // 样板帮助函数
    const callAgent = async (_key: string) => ({
      pages: [
        { key: "derived/x/page-1.png", width: 1600, height: 2263 },
        { key: "derived/x/page-2.png", width: 1600, height: 2263 },
      ],
    })
    const out = await convertPdfToPages(fileId, userId, callAgent)
    expect(out.pages.map((p) => p.name)).toEqual(["检测证书-第1页.png", "检测证书-第2页.png"])
    // 建的记录可按归属查回(走 ownFile 同一路径),status=uploaded,contentType=image/png
  })

  test("非 pdf 文件名 → not_pdf", async () => {
    const { userId, fileId } = await makeUploadedPdf("照片.jpg")
    await expect(convertPdfToPages(fileId, userId, async () => ({ pages: [] })))
      .rejects.toThrow(PdfPagesRejectedError)   // e.code === "not_pdf"
  })

  test("超 20MB → too_large;agent 422 错误码原样透传;agent 连不上 → AgentUnavailableError", async () => {
    // 三段分别断言:size 21MB 的行 → code "too_large";
    // callAgent 抛 PdfPagesRejectedError("too_many_pages") → 透传;
    // callAgent 抛 TypeError(fetch failed) → AgentUnavailableError
  })

  test("他人文件 → FileNotFoundError(404 语义,防越权探测)", async () => {
    const { fileId } = await makeUploadedPdf("检测证书.pdf")
    const stranger = await makeUser()
    await expect(convertPdfToPages(fileId, stranger.id, async () => ({ pages: [] })))
      .rejects.toThrow("not_found")
  })
})
```

(测试骨架里的 `makeUploadedPdf`/`makeUser` 按 apps/api/test 相邻文件的既有帮助函数写法落地——动手前先读一个 files 相关测试文件,抄同款,别自创。第三个 test 的三段各自写全,不许留注释代劳。)

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/api && bun test test/files-pdf-pages.test.ts`
Expected: FAIL,`convertPdfToPages is not exported`

- [ ] **Step 3: 实现 service(services/files.ts 尾部追加)**

```typescript
// ---- 资料库 PDF 转页图(spec 2026-08-08-library-pdf-pages) ----

const PDF_PAGES_MAX_BYTES = 20 * 1024 * 1024 // 证书类不会这么大;防手册误传拖垮 agent
const PDF_PAGES_TIMEOUT_MS = 30_000

export class PdfPagesRejectedError extends Error {
  constructor(public code: "not_pdf" | "too_large" | "too_many_pages" | "unrenderable") {
    super(code)
  }
}
export class AgentUnavailableError extends Error {}

type AgentPage = { key: string; width: number; height: number }

/** 调 agent 工具路由渲染(默认实现;测试注入假的)。agent 422 → 业务码透传,网络失败 → 不可用。 */
async function agentPdfPages(key: string): Promise<{ pages: AgentPage[] }> {
  let r: Response
  try {
    r = await fetch(`${getEnv().AGENT_BASE_URL}/tools/pdf-pages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
      signal: AbortSignal.timeout(PDF_PAGES_TIMEOUT_MS),
    })
  } catch {
    throw new AgentUnavailableError()
  }
  if (r.status === 422) {
    const body = (await r.json().catch(() => ({}))) as { error?: string }
    throw new PdfPagesRejectedError(body.error === "too_many_pages" ? "too_many_pages" : "unrenderable")
  }
  if (!r.ok) throw new AgentUnavailableError()
  return (await r.json()) as { pages: AgentPage[] }
}

/** PDF 附件 → 页图文件记录。归属校验复用 ownFile;页图行 status 直接 uploaded
 *  (对象由 agent 写入 MinIO,不走浏览器直传三段式)。 */
export async function convertPdfToPages(
  fileId: string,
  userId: string,
  callAgent: (key: string) => Promise<{ pages: AgentPage[] }> = agentPdfPages,
): Promise<{ pages: { fileId: string; name: string }[] }> {
  const file = await ownFile(fileId, userId)
  if (!/\.pdf$/i.test(file.filename)) throw new PdfPagesRejectedError("not_pdf")
  if (file.size > PDF_PAGES_MAX_BYTES) throw new PdfPagesRejectedError("too_large")
  const { pages } = await callAgent(file.key)
  const stem = file.filename.replace(/\.pdf$/i, "")
  const out: { fileId: string; name: string }[] = []
  for (const [i, p] of pages.entries()) {
    const name = `${stem}-第${i + 1}页.png`
    const [row] = await getDb()
      .insert(projectFiles)
      .values({
        userId,
        bucket: bucket(),
        key: p.key,
        filename: name,
        contentType: "image/png",
        status: "uploaded",
      })
      .returning()
    out.push({ fileId: row!.id, name })
  }
  return { pages: out }
}
```

- [ ] **Step 4: 路由(routes/files.ts 追加,import 补 `convertPdfToPages, PdfPagesRejectedError, AgentUnavailableError`)**

```typescript
  // 资料库 PDF 转页图:显式动作,错误码逐类给前端出短提示(spec 2026-08-08)
  r.post("/:id/pdf-pages", async (c) => {
    try {
      return c.json(await convertPdfToPages(c.req.param("id"), c.get("user").id))
    } catch (e) {
      if (e instanceof FileNotFoundError) return c.json({ error: "not_found" }, 404)
      if (e instanceof PdfPagesRejectedError)
        return c.json({ error: e.code }, e.code === "too_large" ? 413 : e.code === "not_pdf" ? 400 : 422)
      if (e instanceof AgentUnavailableError) return c.json({ error: "agent_unavailable" }, 502)
      throw e
    }
  })
```

- [ ] **Step 5: 跑测试确认通过 + api 全量**

Run: `cd apps/api && bun test test/files-pdf-pages.test.ts && bun test test/`
Expected: 新文件全绿;全量与 main 基线一致(注意:积分账本约 6 个测试在共享库下恒失败属预存污染,与本改动无关,见记忆——不碰钱的改动核对 main 同样失败即可放行)

- [ ] **Step 6: 提交**

```bash
git add apps/api/src/services/files.ts apps/api/src/routes/files.ts apps/api/test/files-pdf-pages.test.ts
git -c user.name=lookfree -c user.email=etwuman@126.com commit -m "feat(api): relay endpoint converts a library pdf into page-image file records"
```

---

### Task 4: web 类型拓宽 + 插入层跳过规则

**Files:**
- Modify: `apps/web/lib/library.ts`(`LibraryAttachment` 加 `sourceFileId?: string`)
- Modify: `apps/web/app/(tool)/content/use-editor-insert.ts`(新帮助函数 + `libraryItemHtml` 的"附件:"行过滤)
- Test: `apps/web/test/pdf-pages-insert.test.ts`(新建)

**Interfaces:**
- Produces: `hasDerivedPages(att: {fileId: string}, all: {sourceFileId?: string}[]): boolean`(导出,Task 5 的按钮显隐复用);`libraryItemHtml` 行为变化:已转出页图的 PDF 不进"附件:"文件名列表
- Consumes: 现有 `libraryItemHtml(item, images?, alts?)`、`isImageAttachment`

- [ ] **Step 1: 写失败测试**

```typescript
// apps/web/test/pdf-pages-insert.test.ts
// spec 2026-08-08-library-pdf-pages:插入层唯一新规则——已转出页图的 PDF 不再按文件名列出
// (防审查把一份证书数成两份);未转出的 PDF 照旧列出(回归)。
import { describe, expect, test } from "bun:test"
import { hasDerivedPages, libraryItemHtml } from "../app/(tool)/content/use-editor-insert"
import { type LibraryItem } from "../lib/library"

const pdf = { fileId: "f-pdf", name: "检测证书.pdf" }
const page1 = { fileId: "f-p1", name: "检测证书-第1页.png", sourceFileId: "f-pdf" }
const item = (atts: object[]): LibraryItem =>
  ({ id: "i1", title: "检测证书", attachments: atts }) as LibraryItem

describe("已转出页图的 PDF", () => {
  test("hasDerivedPages 按 sourceFileId 配对", () => {
    expect(hasDerivedPages(pdf, [pdf, page1])).toBe(true)
    expect(hasDerivedPages(pdf, [pdf])).toBe(false)
  })

  test("附件行不再列 PDF 文件名,页图正常内嵌", () => {
    const images = new Map([["f-p1", "data:image/jpeg;base64,x"]])
    const html = libraryItemHtml(item([pdf, page1]), images)
    expect(html).toContain('src="data:image/jpeg;base64,x"')
    expect(html).not.toContain("检测证书.pdf")
  })

  test("回归:未转出页图的 PDF 照旧按文件名列出", () => {
    expect(libraryItemHtml(item([pdf]))).toContain("检测证书.pdf")
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && bun test test/pdf-pages-insert.test.ts`
Expected: FAIL,`hasDerivedPages is not exported`

- [ ] **Step 3: 实现**

`apps/web/lib/library.ts`:`LibraryAttachment` 类型加一行 `sourceFileId?: string`(注释:页图附件指向其来源 PDF 的 fileId,spec 2026-08-08)。

`use-editor-insert.ts`,`isImageAttachment` 旁加:

```typescript
/** 该附件是否已有转出的页图(sourceFileId 指向它)。已转出的 PDF 不再按文件名列出,
 *  防审查把一份证书数成两份;按钮显隐同用此判定(item-editor)。 */
export function hasDerivedPages(att: { fileId: string }, all: { sourceFileId?: string }[]): boolean {
  return all.some((a) => a.sourceFileId === att.fileId)
}
```

`libraryItemHtml` 里改一行——`rest` 的过滤补上该判定:

```typescript
  const rest = atts.filter((a) => !embeddedIds.has(a.fileId) && !hasDerivedPages(a, atts))
```

- [ ] **Step 4: 跑测试确认通过 + web 全量**

Run: `cd apps/web && bun test test/pdf-pages-insert.test.ts && bun test test/`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add apps/web/lib/library.ts "apps/web/app/(tool)/content/use-editor-insert.ts" apps/web/test/pdf-pages-insert.test.ts
git -c user.name=lookfree -c user.email=etwuman@126.com commit -m "feat(web): skip pdf filename listing once its page images exist"
```

---

### Task 5: web 附件行「转为图片」按钮

**Files:**
- Modify: `apps/web/app/(tool)/library/item-editor.tsx`(`AttachmentsField` 内加按钮与处理函数)
- Modify: `apps/web/lib/files.ts`(尾部追加错误文案映射)
- Test: `apps/web/test/pdf-pages-errors.test.ts`(新建,纯函数)

**Interfaces:**
- Consumes: Task 3 端点(经现有 `api.request`,POST `/files/${fileId}/pdf-pages` → `{pages: [{fileId, name}]}`,失败抛带 `code` 的 ApiError——先读 `lib/api.ts` 确认错误对象上错误码字段名,与 `uploadErrorMessage` 用的同一个);Task 4 的 `hasDerivedPages`
- Produces: `pdfPagesErrorMessage(e: unknown): string`(导出自 lib/files.ts)

- [ ] **Step 1: 写失败测试(错误文案映射,纯函数)**

```typescript
// apps/web/test/pdf-pages-errors.test.ts
// 显式动作不静默:每个错误码都有短提示(spec 2026-08-08 边界表的文案原文)。
import { describe, expect, test } from "bun:test"
import { pdfPagesErrorMessage } from "../lib/files"

// 按 lib/api.ts 的真实错误对象形状构造(动手前先读它,别猜字段名)
const err = (code: string) => Object.assign(new Error(code), { code })

describe("pdfPagesErrorMessage", () => {
  test("逐码映射 spec 文案", () => {
    expect(pdfPagesErrorMessage(err("too_many_pages"))).toBe("页数超过 5 页,暂不支持转换")
    expect(pdfPagesErrorMessage(err("unrenderable"))).toBe("该 PDF 已加密或无法解析")
    expect(pdfPagesErrorMessage(err("agent_unavailable"))).toBe("转换服务暂不可用,稍后再试")
    expect(pdfPagesErrorMessage(err("too_large"))).toBe("文件过大,暂不支持转换")
  })
  test("未知错误给通用兜底", () => {
    expect(pdfPagesErrorMessage(new Error("boom"))).toBe("转换失败,请稍后再试")
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && bun test test/pdf-pages-errors.test.ts`
Expected: FAIL,`pdfPagesErrorMessage is not exported`

- [ ] **Step 3: 实现文案映射(lib/files.ts 尾部,形态抄同文件 uploadErrorMessage)**

```typescript
/** PDF 转页图的错误短提示(spec 2026-08-08):显式动作不静默,逐码给对应文案。 */
export function pdfPagesErrorMessage(e: unknown): string {
  const code = (e as { code?: string } | null)?.code
  switch (code) {
    case "too_many_pages": return "页数超过 5 页,暂不支持转换"
    case "unrenderable": return "该 PDF 已加密或无法解析"
    case "agent_unavailable": return "转换服务暂不可用,稍后再试"
    case "too_large": return "文件过大,暂不支持转换"
    default: return "转换失败,请稍后再试"
  }
}
```

- [ ] **Step 4: 按钮接入 `AttachmentsField`(item-editor.tsx)**

附件 map 渲染的 `<span>` 内、移除按钮之前,PDF 且未转出页图时给按钮;组件内加状态与处理函数:

```tsx
  const [converting, setConverting] = useState<string | null>(null) // 正在转换的 fileId

  /** 「转为图片」:调转换端点,页图追加为普通附件(带 sourceFileId)。
   *  显式动作不静默:失败按错误码给短提示(pdfPagesErrorMessage)。 */
  async function onConvertPdf(att: LibraryAttachment) {
    if (converting) return
    setConverting(att.fileId)
    onError(null)
    try {
      const { api } = await import("@/lib/api")
      const r = await api.request<{ pages: { fileId: string; name: string }[] }>(
        `/files/${att.fileId}/pdf-pages`, { method: "POST" })
      setAttachments((arr) => [...arr, ...r.pages.map((p) => ({ ...p, sourceFileId: att.fileId }))])
    } catch (e) {
      onError(pdfPagesErrorMessage(e))
    } finally {
      setConverting(null)
    }
  }
```

```tsx
          {/* PDF 需转为图片后才能作为插图进入标书正文;已转出页图的不再显示(防重复转出) */}
          {/\.pdf$/i.test(a.name) && !hasDerivedPages(a, attachments) && (
            <button onClick={() => void onConvertPdf(a)} disabled={converting !== null}
                    title="PDF 需转为图片后才能作为插图进入标书正文"
                    className="text-[11px] text-primary hover:underline disabled:opacity-50">
              {converting === a.fileId ? "转换中…" : "转为图片"}
            </button>
          )}
```

import 区补:`hasDerivedPages`(from `../content/use-editor-insert` 或该项目内既有别名路径,抄同文件其它 import 的写法)、`pdfPagesErrorMessage`(from `@/lib/files`)、`useState`(若未引)。

- [ ] **Step 5: 全量测试 + 构建**

Run: `cd apps/web && bun test test/ && cd ../.. && pnpm --dir apps/web build 2>&1 | tail -3`(若 apps/web 用独立构建命令,按 package.json scripts 为准)
Expected: 测试全绿;构建无类型错误

- [ ] **Step 6: 提交**

```bash
git add "apps/web/app/(tool)/library/item-editor.tsx" apps/web/lib/files.ts apps/web/test/pdf-pages-errors.test.ts
git -c user.name=lookfree -c user.email=etwuman@126.com commit -m "feat(web): convert-to-images button on pdf attachments with explicit errors"
```

---

### Task 6: 发版 230 + 实机验收

**Files:** 无代码;操作任务。

- [ ] **Step 1: 空档发版**(铁律:`project_steps status='running'` 非空不发)

```bash
ssh mbp "cd /Users/Administrator/bid && bash deploy/deploy-cust.sh <本计划末次commit> --only api,agent,web"
# web 有改动:须走 mbp amd64 构建送镜像那套(见记忆 bidsaas-230-cust-deploy);api/agent 230 原生构建
```

- [ ] **Step 2: 实机验收清单**(用真样本《网络安全专用产品安全检测证书.pdf》,2 页扫描件)

1. 资料库新建条目,上传该 PDF → 附件行出现「转为图片」按钮与提示
2. 点按钮 → 出现 `检测证书…-第1页.png`、`-第2页.png` 两个附件
3. 编辑器插入该条目 → 正文出现两张页图(且**没有**"附件:….pdf"那行)
4. 页图 alt 含 OCR 识别文字(现有链路自动跑)
5. 传一个 6 页 PDF → 提示"页数超过 5 页,暂不支持转换",PDF 保留
6. 删除第 2 页附件再插入 → 只嵌第 1 页(用户裁剪能力)

- [ ] **Step 3: 观测复核**

agent 日志无新 ERROR;`derived/` 对象生成;两页转换端到端耗时 < 10s(慢网下按钮不至于被点两次)。
