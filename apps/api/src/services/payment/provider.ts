// 支付通道抽象（架构 §6.0）：路由/订单服务只依赖此接口；换通道只加实现、不动业务。
// 金额一律整数分；clientSn 是我方订单号（送通道、全局唯一）。

export type PaymentResult = {
  status: "paid" | "failed" | "pending"
  sn?: string // 通道订单号（收钱吧 sn）
  tradeNo?: string // 渠道单号（微信/支付宝 trade_no）
  payway?: string // 实际付款方式（对账用）
  totalAmountCents?: number // 通道返回的实付金额（分）；markPaid 前与订单快照核对（铁律）
}

/** 回调解析结果：验签通过且报文合法才给 ok（金额归一为整数分在通道实现内完成，铁律只有一处）。 */
export type CallbackParse =
  | { ok: true; clientSn: string; result: PaymentResult }
  | { ok: false; error: "bad_signature" | "bad_body" }

export interface PaymentProvider {
  /** 通道回调挂载路径（路由 + notify_url 拼接共用，换通道不改路由）。 */
  notifyPath: string
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
  /** 回调验签 + 报文解析归一（路由只消费 PaymentResult，不接触通道线格式；验签失败 bad_signature）。 */
  parseCallback(rawBody: string, authorization: string): CallbackParse
}
