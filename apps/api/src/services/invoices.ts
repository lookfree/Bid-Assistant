import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { getDb } from "../db/client"
import { invoiceRequests, paymentOrders, type InvoiceRequest, type InvoiceTitleType } from "../db/schema"
import { pagedResult } from "../lib/pagination"

// 发票申请（spec332）：money-blind——只读订单、快照订单金额，绝不改积分/余额账本。
export type CreateInvoiceInput = {
  orderId: string
  titleType: InvoiceTitleType
  title: string
  taxNo?: string
  email: string
  remark?: string
}

export type InvoiceErrorCode = "order_not_found" | "order_not_paid" | "tax_no_required" | "invoice_exists"

// 业务错误带 code，路由据此映射 HTTP 状态。
export class InvoiceError extends Error {
  constructor(public code: InvoiceErrorCode) {
    super(code)
  }
}

// 建发票申请：企业抬头强制税号；订单须属本人且已支付；一单一票（pending/issued 已占用则拒，驳回可重申）。
export async function createInvoiceRequest(userId: string, input: CreateInvoiceInput): Promise<InvoiceRequest> {
  if (input.titleType === "enterprise" && !input.taxNo?.trim()) throw new InvoiceError("tax_no_required")
  const db = getDb()
  const [order] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, input.orderId))
  if (!order || order.userId !== userId) throw new InvoiceError("order_not_found")
  if (order.status !== "paid") throw new InvoiceError("order_not_paid")
  const [existing] = await db
    .select({ id: invoiceRequests.id })
    .from(invoiceRequests)
    .where(and(eq(invoiceRequests.orderId, input.orderId), inArray(invoiceRequests.status, ["pending", "issued"])))
  if (existing) throw new InvoiceError("invoice_exists") // 部分唯一索引兜住并发双提交
  const [row] = await db
    .insert(invoiceRequests)
    .values({
      userId,
      orderId: input.orderId,
      amountCents: order.amountCents, // 服务端快照，不信客户端传值
      titleType: input.titleType,
      title: input.title.trim(),
      taxNo: input.taxNo?.trim() || null,
      email: input.email.trim(),
      remark: input.remark?.trim() || null,
    })
    .returning()
  return row!
}

// 本人发票列表（含开票结果/驳回原因，供用户查看状态）；属主隔离：where 带 userId。
export async function listUserInvoices(userId: string, opts: { page?: number; pageSize?: number }) {
  const db = getDb()
  const page = opts.page ?? 1
  const pageSize = opts.pageSize ?? 20
  return pagedResult(
    db
      .select()
      .from(invoiceRequests)
      .where(eq(invoiceRequests.userId, userId))
      .orderBy(desc(invoiceRequests.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)` }).from(invoiceRequests).where(eq(invoiceRequests.userId, userId)),
  )
}
