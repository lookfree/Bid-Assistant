import { pgTable, uuid, text, integer, index, uniqueIndex, check } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { id, tz, createdAt } from "./columns"
import { users } from "./users"
import { paymentOrders } from "./payments"

// 发票申请（spec332 / YFZQ-3）：会员中心「开发票」。
// money-blind：只引用订单并快照订单金额，绝不改积分/余额账本、不写 credit_transactions。
// 本期运营手工开票（pending→issued/rejected）；invoice_no/file_url 预留给未来三方电子发票自动开具。
export const INVOICE_TITLE_TYPES = ["personal", "enterprise"] as const
export type InvoiceTitleType = (typeof INVOICE_TITLE_TYPES)[number]
export const INVOICE_STATUSES = ["pending", "issued", "rejected"] as const
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number]

export const invoiceRequests = pgTable(
  "invoice_requests",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => paymentOrders.id),
    amountCents: integer("amount_cents").notNull(), // 快照=订单金额，服务端取，不信客户端
    titleType: text("title_type").$type<InvoiceTitleType>().notNull(),
    title: text("title").notNull(), // 抬头名称
    taxNo: text("tax_no"), // 企业抬头必填（应用层校验）
    email: text("email").notNull(), // 收票邮箱
    remark: text("remark"),
    status: text("status").$type<InvoiceStatus>().notNull().default("pending"),
    invoiceNo: text("invoice_no"), // 开具后回填
    fileKey: text("file_key"), // 运营上传的电子发票 PDF 的 MinIO 对象 key（下载现签用）
    fileUrl: text("file_url"), // 备选：运营粘贴的外链（无上传时）
    rejectReason: text("reject_reason"),
    handledBy: text("handled_by"), // admin username（与审计 operator 口径一致，不做 FK）
    handledAt: tz("handled_at"),
    createdAt: createdAt(),
  },
  (t) => ({
    userIdx: index("invoice_requests_user_idx").on(t.userId, t.createdAt),
    statusIdx: index("invoice_requests_status_idx").on(t.status, t.createdAt),
    // 一单一票：同一订单最多一张「进行中/已开」发票；驳回（rejected）不占用，可重新申请。
    activeOrderUniq: uniqueIndex("invoice_requests_active_order_uniq")
      .on(t.orderId)
      .where(sql`status in ('pending','issued')`),
    titleTypeCheck: check("invoice_title_type_check", sql`${t.titleType} in ('personal','enterprise')`),
    statusCheck: check("invoice_status_check", sql`${t.status} in ('pending','issued','rejected')`),
    amountCheck: check("invoice_amount_check", sql`${t.amountCents} > 0`),
  }),
)

export type InvoiceRequest = typeof invoiceRequests.$inferSelect
