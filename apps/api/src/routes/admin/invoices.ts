import { Hono } from "hono"
import { z } from "zod"
import { requirePermission } from "../../middleware/admin-auth"
import { parsePagination, pagedBody } from "../../lib/pagination"
import { isUuid } from "../../lib/uuid"
import { listInvoices, issueInvoice, rejectInvoice, InvoiceError } from "../../services/invoices"
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
  const result = await listInvoices({
    status: (status as InvoiceStatus | undefined) || undefined,
    userId: c.req.query("userId") || undefined,
    page: pg.page,
    pageSize: pg.pageSize,
  })
  return c.json(pagedBody(pg, result))
})

const PatchBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("issue"), invoiceNo: z.string().min(1).max(100), fileUrl: z.string().max(500).optional() }),
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
        ? await issueInvoice(id, { invoiceNo: parsed.data.invoiceNo, fileUrl: parsed.data.fileUrl }, { operator })
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
