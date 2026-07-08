import { Hono } from "hono"
import { z } from "zod"
import { authMiddleware } from "../middleware/auth"
import {
  presignUpload,
  confirmUpload,
  presignDownload,
  FileTooLargeError,
  FileNotFoundError,
  ObjectMissingError,
  UnsupportedFileTypeError,
} from "../services/files"
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
      throw e
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

  return r
}
