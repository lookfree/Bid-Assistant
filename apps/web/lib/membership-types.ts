import type { TierId, Feature } from "./plans"

// 会员中心后端出参类型（spec308，与 App 层 GET /api/membership 等一一对应，camelCase）。
// 复用 plans.ts 的 TierId/Feature，避免重复定义档位枚举与权益项形状。
export type { TierId, Feature }
export type Payway = "alipay" | "wechat"

export interface SubscriptionView {
  status: "active" | "past_due" | "expired" | "none"
  planId: string | null
  tierId: TierId
  billingCycle: "month" | "quarter" | "year" | null
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
}

export interface PlanView {
  id: string
  planIdMonth: string | null // 月付 plan 行 id（前端按计费周期下单，避免年付误按月价成单）
  planIdYear: string | null // 年付 plan 行 id
  name: string
  tierId: TierId
  priceMonthCents: number
  priceMonthYuan: number
  priceYearCents: number
  priceYearYuan: number
  grantCreditsPerCycle: number
  features: Feature[]
  recommended: boolean
}

export interface RechargePackView {
  id: string
  credits: number
  amountCents: number
  amountYuan: number
}

export interface CreditCostView {
  key: string
  feature: string
  desc: string
  value: number
  cost: string // 展示串，如 "20 积分 / 份"
}

export interface MembershipOverview {
  subscription: SubscriptionView
  balance: number
  plans: PlanView[]
  rechargePacks: RechargePackView[] // 充值包目录（服务端定价为准；前端按 id 下单）
  creditCosts: CreditCostView[] // 积分消耗口径 9 项（运营后台可配，实时）
  progressive: { current: PlanView | null; next: PlanView | null }
}

export interface CreditTxView {
  id: string
  type: "grant" | "purchase" | "hold" | "settle" | "release" | "expire" | "referral_reward" | "refund_clawback"
  amount: number
  ref: string | null
  expireAt: string | null
  createdAt: string
}

export interface OrderView {
  id: string
  type: "recharge" | "purchase" | "renewal"
  amountCents: number
  amountYuan: number
  status: "created" | "paid" | "failed" | "unknown" | "refunded"
  provider: string
  createdAt: string
}

// 发票申请（spec332）：与 App 层 invoice_requests 行一一对应（camelCase）。money-blind。
export interface InvoiceView {
  id: string
  orderId: string
  amountCents: number
  titleType: "personal" | "enterprise"
  title: string
  taxNo: string | null
  email: string
  remark: string | null
  status: "pending" | "issued" | "rejected"
  invoiceNo: string | null
  fileUrl: string | null
  rejectReason: string | null
  createdAt: string
}

export interface CreateInvoicePayload {
  orderId: string
  titleType: "personal" | "enterprise"
  title: string
  taxNo?: string
  email: string
  remark?: string
}

export interface Paged<T> {
  items: T[]
  page: number
  pageSize: number
  total: number
  hasMore: boolean
}

/** 下单响应（spec304 recharge / spec305 renew 共用）：qrCode 供前端转二维码扫码。 */
export interface LaunchResponse {
  orderId: string
  qrCode: string
  qrImageUrl?: string
}
