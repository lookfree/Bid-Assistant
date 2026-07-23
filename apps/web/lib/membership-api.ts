import { api, type RequestFn } from "./api"
import type { MembershipOverview, Paged, CreditTxView, OrderView, LaunchResponse, Payway, InvoiceView, CreateInvoicePayload } from "./membership-types"

// 会员中心前端 API 封装（spec308）：建在共享 api.request 上，鉴权头/baseUrl/401 语义全部复用。
// 工厂形式便于测试注入 request（对齐 api-client.test 的 fetchImpl 注入模式）。

export function createMembershipApi(request: RequestFn) {
  return {
    fetchMembership: () => request<MembershipOverview>("/api/membership"),
    fetchCreditTransactions: (page = 1, pageSize = 20) =>
      request<Paged<CreditTxView>>(`/api/credits/transactions?page=${page}&pageSize=${pageSize}`),
    fetchOrders: (page = 1, pageSize = 20) => request<Paged<OrderView>>(`/api/orders?page=${page}&pageSize=${pageSize}`),
    // 充值：服务端定价，客户端只传 packId + payway（spec304）
    startRecharge: (packId: string, payway: Payway) =>
      request<LaunchResponse>("/api/payment/recharge", { method: "POST", body: JSON.stringify({ packId, payway }) }),
    // 开通/续费：服务端定价，客户端只传 planId + payway（spec305，扫码单笔）
    renewMembership: (planId: string, payway: Payway) =>
      request<LaunchResponse>("/api/membership/renew", { method: "POST", body: JSON.stringify({ planId, payway }) }),
    // 发票申请（spec332）：金额取订单快照，客户端只传订单 + 抬头信息。
    fetchInvoices: (page = 1, pageSize = 50) => request<Paged<InvoiceView>>(`/api/invoices?page=${page}&pageSize=${pageSize}`),
    createInvoice: (payload: CreateInvoicePayload) =>
      request<InvoiceView>("/api/invoices", { method: "POST", body: JSON.stringify(payload) }),
  }
}

export const membershipApi = createMembershipApi(api.request)
export const { fetchMembership, fetchCreditTransactions, fetchOrders, startRecharge, renewMembership, fetchInvoices, createInvoice } =
  membershipApi
