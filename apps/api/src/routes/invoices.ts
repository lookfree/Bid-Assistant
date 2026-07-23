import { Hono } from "hono"
import { z } from "zod"
import type { User } from "../db/schema"
import { authMiddleware } from "../middleware/auth"
import { getUserId } from "../lib/auth-user"
import { parsePagination, pagedBody } from "../lib/pagination"
import { createInvoiceRequest, listUserInvoices, InvoiceError } from "../services/invoices"

// C 端发票申请（spec332 / YFZQ-3）：money-blind，自带 authMiddleware。
const CreateBody = z.object({
  orderId: z.string().uuid(),
  titleType: z.enum(["personal", "enterprise"]),
  title: z.string().min(1).max(200),
  taxNo: z.string().max(50).optional(),
  email: z.string().email().max(200),
  remark: z.string().max(500).optional(),
})

export function invoiceRoutes() {
  const r = new Hono<{ Variables: { user: User } }>()
  r.use("*", authMiddleware)

  r.post("/", async (c) => {
    const parsed = CreateBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
    try {
      return c.json(await createInvoiceRequest(getUserId(c), parsed.data), 201)
    } catch (e) {
      if (e instanceof InvoiceError) {
        const status = e.code === "order_not_found" ? 404 : e.code === "invoice_exists" ? 409 : 400
        return c.json({ error: e.code }, status)
      }
      throw e
    }
  })

  r.get("/", async (c) => {
    let pg
    try {
      pg = parsePagination(c.req.query())
    } catch {
      return c.json({ error: "invalid_pagination" }, 400)
    }
    return c.json(pagedBody(pg, await listUserInvoices(getUserId(c), { page: pg.page, pageSize: pg.pageSize })))
  })

  return r
}
