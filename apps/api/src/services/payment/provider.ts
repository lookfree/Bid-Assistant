// 支付通道抽象（架构 §6.0）：路由/订单服务只依赖此接口；换通道只加实现、不动业务。
// 金额一律整数分；clientSn 是我方订单号（送通道、全局唯一）。

export type PaymentResult = {
  status: "paid" | "failed" | "pending"
  sn?: string // 通道订单号（收钱吧 sn）
  tradeNo?: string // 渠道单号（微信/支付宝 trade_no）
  payway?: string // 实际付款方式（对账用）
}

export interface PaymentProvider {
  /** 生成顾客扫码的跳转支付 URL（前端转二维码）。 */
  createPayment(opts: {
    clientSn: string
    amountCents: number
    subject: string
    returnUrl: string
    notifyUrl: string
  }): Promise<{ payUrl: string }>
  /** 查询交易终态（轮询/对账共用）。 */
  query(clientSn: string): Promise<PaymentResult>
  /** 退款（支持部分退款；refundSn 幂等）。业务失败返回 ok:false，不抛。 */
  refund(opts: { clientSn: string; refundSn: string; amountCents: number }): Promise<{ ok: boolean }>
  /** 回调验签：body 原文 + Authorization 头签名 → 布尔。 */
  verifyCallback(rawBody: string, authorization: string): boolean
}
