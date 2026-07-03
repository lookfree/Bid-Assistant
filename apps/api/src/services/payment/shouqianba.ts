import { md5BodySign, wap2Sign, verifyRsaCallback } from "./shouqianba-sign"
import type { PaymentProvider, PaymentResult } from "./provider"

// 收钱吧通道实现（架构 §6.0/§6.1）：无官方 SDK，HTTPS+JSON 直连网关。
// 跳转支付（WAP2）走 wapGateway + 参数签名；查询/退款走 API 网关 + terminal body 签名；
// 回调用收钱吧公钥 RSA 验签。端点路径以 doc.shouqianba.com 为准，Task 4 真实冒烟校验。

export type ShouqianbaConfig = {
  gateway: string // API 网关 https://vsi-api.shouqianba.com
  wapGateway: string // WAP2 跳转支付网关（如 https://qr.shouqianba.com/gateway）
  publicKey: string // 收钱吧回调验签公钥（PEM）
}

export type ShouqianbaDeps = {
  cfg: ShouqianbaConfig
  /** 终端凭证（terminal.ts 提供；测试注入固定值） */
  getCredentials: () => Promise<{ terminalSn: string; terminalKey: string }>
  fetchFn?: typeof fetch
}

// order_status → PaymentResult.status 映射；未知状态一律 pending（钱可能已付，不敢判 failed）
const FAILED_STATUSES = new Set(["CANCELED", "PAY_CANCELED", "EXPIRED", "PAY_ERROR"])

type BizResponse = {
  result_code?: string
  error_message?: string
  data?: { order_status?: string; sn?: string; trade_no?: string; payway?: string; total_amount?: string }
}

export function makeShouqianbaProvider(deps: ShouqianbaDeps): PaymentProvider {
  const fetchFn = deps.fetchFn ?? fetch
  const { cfg } = deps

  /** API 网关 POST（terminal body 签名）。HTTP/解析失败抛错，业务码由调用方判。 */
  async function post(path: string, payload: Record<string, string>): Promise<{ result_code?: string; biz_response?: BizResponse }> {
    const { terminalSn, terminalKey } = await deps.getCredentials()
    const body = JSON.stringify({ terminal_sn: terminalSn, ...payload })
    const resp = await fetchFn(`${cfg.gateway}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `${terminalSn} ${md5BodySign(body, terminalKey)}` },
      body,
    })
    if (!resp.ok) throw new Error(`收钱吧网关 HTTP ${resp.status}: ${path}`)
    return (await resp.json()) as { result_code?: string; biz_response?: BizResponse }
  }

  return {
    async createPayment(opts) {
      const { terminalSn, terminalKey } = await deps.getCredentials()
      const params: Record<string, string> = {
        terminal_sn: terminalSn,
        client_sn: opts.clientSn,
        total_amount: String(opts.amountCents), // 单位分
        subject: opts.subject,
        return_url: opts.returnUrl,
        notify_url: opts.notifyUrl,
      }
      const qs = new URLSearchParams({ ...params, sign: wap2Sign(params, terminalKey) })
      return { payUrl: `${cfg.wapGateway}?${qs.toString()}` }
    },

    async query(clientSn): Promise<PaymentResult> {
      const json = await post("/upay/v2/query", { client_sn: clientSn })
      const biz = json.biz_response
      if (json.result_code !== "200" || biz?.result_code !== "SUCCESS") {
        throw new Error(`收钱吧查询失败: ${json.result_code} ${biz?.error_message ?? ""}`)
      }
      const d = biz.data ?? {}
      const status: PaymentResult["status"] =
        d.order_status === "PAID" ? "paid" : FAILED_STATUSES.has(d.order_status ?? "") ? "failed" : "pending"
      const amount = d.total_amount != null ? Number(d.total_amount) : undefined
      return { status, sn: d.sn, tradeNo: d.trade_no, payway: d.payway, totalAmountCents: Number.isFinite(amount) ? amount : undefined }
    },

    async refund({ clientSn, refundSn, amountCents }) {
      const json = await post("/upay/v2/refund", {
        client_sn: clientSn,
        refund_request_no: refundSn, // 通道侧幂等键：同号重复请求不重复退
        refund_amount: String(amountCents),
      })
      return { ok: json.result_code === "200" && json.biz_response?.result_code === "REFUND_SUCCESS" }
    },

    verifyCallback(rawBody, authorization) {
      return verifyRsaCallback(rawBody, authorization, cfg.publicKey)
    },
  }
}
