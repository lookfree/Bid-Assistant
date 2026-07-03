import { pgTable, uuid, text, integer, index, unique, check } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { id, createdAt, tz } from "./columns"
import { users } from "./users"

// 支付订单（收钱吧 C 扫 B）：金额一律整数分；服务端定价快照，不信客户端金额。
export const paymentOrders = pgTable(
  "payment_orders",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // recharge/purchase/renewal
    amountCents: integer("amount_cents").notNull(), // 订单金额快照（分）
    status: text("status").notNull().default("created"), // created/paid/failed/unknown/refunded
    provider: text("provider").notNull().default("shouqianba"),
    clientSn: text("client_sn").notNull().unique(), // 我方订单号（送收钱吧，全局唯一）
    providerTradeNo: text("provider_trade_no"), // 收钱吧订单号 sn
    channelTradeNo: text("channel_trade_no"), // 微信/支付宝渠道单号 trade_no
    payway: text("payway"), // 实际付款方式（对账用）
    idempotencyKey: text("idempotency_key").notNull(), // 幂等键必填（nullable+unique 会被多 NULL 绕过）
    createdAt: createdAt(),
  },
  (t) => ({
    userIdx: index("payment_orders_user_idx").on(t.userId),
    idemUq: unique("payment_orders_idem_uq").on(t.idempotencyKey),
    amountPositive: check("payment_orders_amount_positive", sql`${t.amountCents} > 0`), // 钱从严：DB 层拒绝非正金额
    typeCheck: check("payment_orders_type_check", sql`${t.type} in ('recharge','purchase','renewal')`),
    statusCheck: check("payment_orders_status_check",
      sql`${t.status} in ('created','paid','failed','unknown','refunded')`),
  }),
)

// 收钱吧交易终端凭证：激活产生、每日签到轮换 terminal_key（架构 §6.0）。
// 集群共享唯一真相；terminal_key 加密存储（AES，密钥走 env）；密钥丢失只能重激活。
export const paymentTerminals = pgTable("payment_terminals", {
  id: id(),
  terminalSn: text("terminal_sn").notNull().unique(),
  terminalKey: text("terminal_key").notNull(), // 加密存储
  deviceId: text("device_id").notNull().unique(), // 激活时自定义设备号（带业务含义）
  activatedAt: tz("activated_at").notNull().defaultNow(),
  lastCheckinAt: tz("last_checkin_at"), // 每日签到成功后更新
})

// 退款：唯一入口在运营后台（spec310，过 RBAC+审计）；支持部分退款。
export const refunds = pgTable(
  "refunds",
  {
    id: id(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => paymentOrders.id),
    amountCents: integer("amount_cents").notNull(),
    reason: text("reason"),
    status: text("status").notNull().default("pending"), // pending/done/failed
    operator: text("operator"), // 运营操作人（admin）
    createdAt: createdAt(),
  },
  (t) => ({
    amountPositive: check("refunds_amount_positive", sql`${t.amountCents} > 0`), // 退款金额同样必须为正
    statusCheck: check("refunds_status_check", sql`${t.status} in ('pending','done','failed')`),
  }),
)
