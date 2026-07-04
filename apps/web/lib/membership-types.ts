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

export interface MembershipOverview {
  subscription: SubscriptionView
  balance: number
  plans: PlanView[]
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
