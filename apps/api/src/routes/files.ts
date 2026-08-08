import { Hono } from "hono"
import { z } from "zod"
import { authMiddleware } from "../middleware/auth"
import {
  presignUpload,
  confirmUpload,
  presignDownload,
  convertPdfToPages,
  FileTooLargeError,
  FileNotFoundError,
  ObjectMissingError,
  UnsupportedFileTypeError,
  FileContentRejectedError,
  PdfPagesRejectedError,
  AgentUnavailableError,
} from "../services/files"
import { ocrImage, OcrUnconfiguredError } from "../services/ocr"
import type { User } from "../db/schema"

const presignSchema = z.object({
  filename: z.string().min(1).max(200),
  contentType: z.string().min(1),
  size: z.coerce.number().int().nonnegative(),
})

export function fileRoutes() {
  const r = new Hono<{ Variables: { user: User } }>()
  r.use("*", authMiddleware) // /files/* 全部需登录，文件属本人

  r.post("/presign-upload", async (c) => {
    const body = presignSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid_input" }, 400)
    try {
      const out = await presignUpload({ userId: c.get("user").id, ...body.data })
      return c.json(out)
    } catch (e) {
      if (e instanceof FileTooLargeError) return c.json({ error: "file_too_large" }, 400)
      if (e instanceof UnsupportedFileTypeError) return c.json({ error: "unsupported_file_type" }, 400)
      throw e
    }
  })

  r.post("/:id/complete", async (c) => {
    try {
      const file = await confirmUpload(c.req.param("id"), c.get("user").id)
      return c.json({ file })
    } catch (e) {
      if (e instanceof FileNotFoundError) return c.json({ error: "not_found" }, 404)
      if (e instanceof ObjectMissingError) return c.json({ error: "object_missing" }, 409)
      if (e instanceof FileTooLargeError) return c.json({ error: "file_too_large" }, 400)
      // 内容与扩展名不符/被加密软件封装：前端按 code 出文案（uploadErrorMessage）。
      if (e instanceof FileContentRejectedError) return c.json({ error: e.code }, 400)
      throw e
    }
  })

  // 正文插图的文字识别：前端压缩后的图片 → 识别文字 → 前端写进 <img alt>。
  // OCR 未部署或识别失败一律回 { text: "" }，插图流程不受影响——识别是增强，不是前置条件。
  r.post("/ocr", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { image?: string }
    if (!body.image || body.image.length < 16) return c.json({ error: "invalid_input" }, 400)
    // 上限在这一层也要有：OCR 容器里那道 8MB 卡是最后一道，走到那里时 App 已经把整串
    // base64 收进内存又序列化了一遍。前端产出的是 ≤1200px 的 JPEG，12MB 绰绰有余。
    if (body.image.length > 12 * 1024 * 1024) return c.json({ error: "image_too_large" }, 413)
    try {
      return c.json({ text: await ocrImage(body.image) })
    } catch (e) {
      if (e instanceof OcrUnconfiguredError) return c.json({ text: "" })
      console.warn("[ocr] 识别失败（不影响插图）:", e)
      return c.json({ text: "" })
    }
  })

  r.get("/:id/download-url", async (c) => {
    try {
      return c.json(await presignDownload(c.req.param("id"), c.get("user").id))
    } catch (e) {
      if (e instanceof FileNotFoundError) return c.json({ error: "not_found" }, 404)
      throw e
    }
  })

  // 资料库 PDF 转页图：显式动作，错误码逐类给前端出短提示（spec 2026-08-08）
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

  return r
}
