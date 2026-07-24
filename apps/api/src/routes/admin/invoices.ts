import { Hono } from "hono"
import { z } from "zod"
import { requirePermission } from "../../middleware/admin-auth"
import { parsePagination, pagedBody } from "../../lib/pagination"
import { isUuid } from "../../lib/uuid"
import { listInvoices, issueInvoice, rejectInvoice, uploadInvoiceFile, MAX_INVOICE_FILE_BYTES, InvoiceError } from "../../services/invoices"
import { INVOICE_STATUSES, type InvoiceStatus, type AdminUser } from "../../db/schema"

// 发票管理页（spec332）：读+写=invoice.write（superadmin/finance）。开具/驳回落审计,仅 pending 可流转。
export const invoicesRouter = new Hono<{ Variables: { admin: AdminUser } }>()

invoicesRouter.get("/", requirePermission("invoice.write"), async (c) => {
  let pg
  try {
    pg = parsePagination(c.req.query())
  } catch {
    return c.json({ error: "invalid_pagination" }, 400)
  }
  const status = c.req.query("status")
  if (status && !(INVOICE_STATUSES as readonly string[]).includes(status)) return c.json({ error: "invalid_input" }, 400)
  const userId = c.req.query("userId") || undefined
  if (userId && !isUuid(userId)) return c.json({ error: "invalid_input" }, 400) // 非 uuid 会撞 PG 22P02→500
  const result = await listInvoices({
    status: (status as InvoiceStatus | undefined) || undefined,
    userId,
    page: pg.page,
    pageSize: pg.pageSize,
  })
  return c.json(pagedBody(pg, result))
})

// 上传电子发票文件（multipart，字段名 file）：经 API 中转直传 MinIO，返回 { key }，随开具回填。
invoicesRouter.post("/:id/file", requirePermission("invoice.write"), async (c) => {
  const id = c.req.param("id")
  if (!isUuid(id)) return c.json({ error: "invoice_not_found" }, 404)
  const file = (await c.req.parseBody()).file
  if (!(file instanceof File)) return c.json({ error: "invalid_input" }, 400)
  if (file.size > MAX_INVOICE_FILE_BYTES) return c.json({ error: "file_too_large" }, 400) // 读进内存前先按 size 拒，防 OOM
  try {
    return c.json(await uploadInvoiceFile(id, file.name, new Uint8Array(await file.arrayBuffer())))
  } catch (e) {
    if (e instanceof InvoiceError) {
      const status = e.code === "invoice_not_found" ? 404 : e.code === "not_pending" ? 409 : 400
      return c.json({ error: e.code }, status)
    }
    throw e
  }
})

const PatchBody = z.discriminatedUnion("action", [
  // 开具必须带电子发票文件（fileKey）——否则用户无从下载，故必填。
  z.object({ action: z.literal("issue"), invoiceNo: z.string().min(1).max(100), fileKey: z.string().min(1).max(300) }),
  z.object({ action: z.literal("reject"), reason: z.string().min(1).max(500) }),
])

invoicesRouter.patch("/:id", requirePermission("invoice.write"), async (c) => {
  const id = c.req.param("id")
  if (!isUuid(id)) return c.json({ error: "invoice_not_found" }, 404) // 非 uuid 与不存在同语义,避免 PG 22P02 500
  const parsed = PatchBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
  const operator = c.var.admin.username
  try {
    const row =
      parsed.data.action === "issue"
        ? await issueInvoice(id, { invoiceNo: parsed.data.invoiceNo, fileKey: parsed.data.fileKey }, { operator })
        : await rejectInvoice(id, { reason: parsed.data.reason }, { operator })
    return c.json(row)
  } catch (e) {
    if (e instanceof InvoiceError) {
      const status = e.code === "invoice_not_found" ? 404 : e.code === "not_pending" ? 409 : 400
      return c.json({ error: e.code }, status)
    }
    throw e
  }
})
