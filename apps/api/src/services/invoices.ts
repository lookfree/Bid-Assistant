import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { getDb } from "../db/client"
import { invoiceRequests, paymentOrders, type InvoiceRequest, type InvoiceStatus, type InvoiceTitleType } from "../db/schema"
import { randomUUID } from "node:crypto"
import { pagedResult } from "../lib/pagination"
import { writeAudit } from "./audit"
import { presignGet, putObject } from "../storage/s3"

const DOWNLOAD_TTL = 3600 // 站内下载现签有效期（列表每次刷新重签，短即可）
export const MAX_INVOICE_FILE_BYTES = 10 * 1024 * 1024 // 电子发票文件 ≤ 10MB
const UPLOAD_EXTS: Record<string, string> = { pdf: "application/pdf", ofd: "application/octet-stream", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png" }

// Postgres 唯一约束冲突（23505）——postgres.js 把 code 挂在错误或其 cause 上。
function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string })?.code ?? (e as { cause?: { code?: string } })?.cause?.code
  return code === "23505"
}

// 站内下载 URL：presignGet 返回 /s3 代理相对路径（C 端同源可直点）。文件名带真实扩展名。
async function invoiceDownloadUrl(fileKey: string): Promise<string> {
  const ext = fileKey.split(".").pop()?.toLowerCase() || "pdf"
  return presignGet(fileKey, DOWNLOAD_TTL, `invoice.${ext}`)
}

// 发票申请（spec332）：money-blind——只读订单、快照订单金额，绝不改积分/余额账本。
export type CreateInvoiceInput = {
  orderId: string
  titleType: InvoiceTitleType
  title: string
  taxNo?: string
  remark?: string
}

export type InvoiceErrorCode =
  | "order_not_found"
  | "order_not_paid"
  | "tax_no_required"
  | "invoice_exists"
  | "invoice_not_found"
  | "not_pending"
  | "unsupported_file"
  | "file_too_large"
  | "invalid_file"

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
  if (existing) throw new InvoiceError("invoice_exists")
  try {
    const [row] = await db
      .insert(invoiceRequests)
      .values({
        userId,
        orderId: input.orderId,
        amountCents: order.amountCents, // 服务端快照，不信客户端传值
        titleType: input.titleType,
        title: input.title.trim(),
        taxNo: input.taxNo?.trim() || null,
        remark: input.remark?.trim() || null,
      })
      .returning()
    return row!
  } catch (e) {
    // 并发双提交：部分唯一索引拒第二条 → 映射成干净的 409，而非 500。
    if (isUniqueViolation(e)) throw new InvoiceError("invoice_exists")
    throw e
  }
}

// 本人发票列表：只投影 C 端可见列（不泄漏 handledBy/fileKey/email/fileUrl 等内部字段）。
// 已开票且有上传文件的附现签下载链接；单行 presign 失败仅该行无链接，不拖垮整批。
export async function listUserInvoices(userId: string, opts: { page?: number; pageSize?: number }) {
  const db = getDb()
  const page = opts.page ?? 1
  const pageSize = opts.pageSize ?? 20
  const view = {
    id: invoiceRequests.id,
    userId: invoiceRequests.userId,
    orderId: invoiceRequests.orderId,
    amountCents: invoiceRequests.amountCents,
    titleType: invoiceRequests.titleType,
    title: invoiceRequests.title,
    taxNo: invoiceRequests.taxNo,
    remark: invoiceRequests.remark,
    status: invoiceRequests.status,
    invoiceNo: invoiceRequests.invoiceNo,
    rejectReason: invoiceRequests.rejectReason,
    createdAt: invoiceRequests.createdAt,
  }
  const res = await pagedResult(
    db
      .select({ ...view, fileKey: invoiceRequests.fileKey }) // fileKey 仅用于现签，不外泄
      .from(invoiceRequests)
      .where(eq(invoiceRequests.userId, userId))
      .orderBy(desc(invoiceRequests.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)` }).from(invoiceRequests).where(eq(invoiceRequests.userId, userId)),
  )
  const items = await Promise.all(
    res.items.map(async ({ fileKey, ...row }) => {
      if (row.status !== "issued" || !fileKey) return row
      try {
        return { ...row, downloadUrl: await invoiceDownloadUrl(fileKey) }
      } catch {
        return row // 现签失败：该行无下载链接，不让整个发票列表 500
      }
    }),
  )
  return { items, total: res.total }
}

// —— 管理端（spec332；invoice.write：superadmin/finance）——

// 管理端列表：按状态/用户筛选 + 分页。
export async function listInvoices(opts: { status?: InvoiceStatus; userId?: string; page?: number; pageSize?: number }) {
  const db = getDb()
  const page = opts.page ?? 1
  const pageSize = opts.pageSize ?? 20
  const conds = []
  if (opts.status) conds.push(eq(invoiceRequests.status, opts.status))
  if (opts.userId) conds.push(eq(invoiceRequests.userId, opts.userId))
  const where = conds.length ? and(...conds) : undefined
  return pagedResult(
    db.select().from(invoiceRequests).where(where).orderBy(desc(invoiceRequests.createdAt)).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)` }).from(invoiceRequests).where(where),
  )
}

// 装载并守卫为 pending（供上传前校验用）；不存在→invoice_not_found，终态→not_pending。
async function loadPending(id: string): Promise<InvoiceRequest> {
  const [row] = await getDb().select().from(invoiceRequests).where(eq(invoiceRequests.id, id))
  if (!row) throw new InvoiceError("invoice_not_found")
  if (row.status !== "pending") throw new InvoiceError("not_pending")
  return row
}

// pending→终态 的原子流转：UPDATE ... WHERE status='pending'，0 行时再查存在性区分 404/409（消除 TOCTOU）。
async function transition(id: string, set: Partial<typeof invoiceRequests.$inferInsert>): Promise<InvoiceRequest> {
  const [after] = await getDb()
    .update(invoiceRequests)
    .set(set)
    .where(and(eq(invoiceRequests.id, id), eq(invoiceRequests.status, "pending")))
    .returning()
  if (after) return after
  const [exists] = await getDb().select({ id: invoiceRequests.id }).from(invoiceRequests).where(eq(invoiceRequests.id, id))
  throw new InvoiceError(exists ? "not_pending" : "invoice_not_found")
}

// 开具：pending→issued，回填发票号 + 电子发票文件 key，落审计。用户在会员中心自行下载。
export async function issueInvoice(id: string, input: { invoiceNo: string; fileKey: string }, opts: { operator: string }): Promise<InvoiceRequest> {
  const fileKey = input.fileKey.trim()
  // fileKey 必须是本发票 upload 出来的对象（前缀绑定），防止指向他人发票文件。
  if (!fileKey.startsWith(`invoices/${id}/`)) throw new InvoiceError("invalid_file")
  const after = await transition(id, { status: "issued", invoiceNo: input.invoiceNo.trim(), fileKey, handledBy: opts.operator, handledAt: new Date() })
  await writeAudit({ operator: opts.operator, action: "invoice.issue", target: `invoice:${id}`, before: { status: "pending" }, after: { status: "issued", invoiceNo: after.invoiceNo } })
  return after
}

// 驳回：pending→rejected，记原因，落审计。
export async function rejectInvoice(id: string, input: { reason: string }, opts: { operator: string }): Promise<InvoiceRequest> {
  const after = await transition(id, { status: "rejected", rejectReason: input.reason.trim(), handledBy: opts.operator, handledAt: new Date() })
  await writeAudit({ operator: opts.operator, action: "invoice.reject", target: `invoice:${id}`, before: { status: "pending" }, after: { status: "rejected", reason: after.rejectReason } })
  return after
}

// 运营上传电子发票文件（invoice.write）：先校验发票存在且 pending（避免孤儿对象），再经 API 中转直传 MinIO。
export async function uploadInvoiceFile(invoiceId: string, filename: string, bytes: Uint8Array): Promise<{ key: string }> {
  const ext = filename.split(".").pop()?.toLowerCase() ?? ""
  const contentType = UPLOAD_EXTS[ext]
  if (!contentType) throw new InvoiceError("unsupported_file")
  if (bytes.byteLength > MAX_INVOICE_FILE_BYTES) throw new InvoiceError("file_too_large")
  await loadPending(invoiceId) // 发票须存在且待开票，否则拒收（不产生孤儿对象）
  const key = `invoices/${invoiceId}/${randomUUID()}.${ext}`
  await putObject(key, bytes, contentType)
  return { key }
}
