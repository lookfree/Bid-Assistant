import { z } from "zod"
import { wap2Sign, verifyRsaCallback } from "./shouqianba-sign"
import { sqbPost } from "./gateway"
import type { CallbackParse, PaymentProvider, PaymentResult } from "./provider"

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

/** 通道报文 → PaymentResult 归一（查询响应与回调共用：金额转整数分只在这一处）。 */
function normalizeResult(d: { order_status?: string; sn?: string; trade_no?: string; payway?: string; total_amount?: string }): PaymentResult {
  const status: PaymentResult["status"] =
    d.order_status === "PAID" ? "paid" : FAILED_STATUSES.has(d.order_status ?? "") ? "failed" : "pending"
  const amount = d.total_amount != null ? Number(d.total_amount) : undefined
  return { status, sn: d.sn, tradeNo: d.trade_no, payway: d.payway, totalAmountCents: Number.isFinite(amount) ? amount : undefined }
}

const callbackSchema = z.object({
  client_sn: z.string().min(1),
  order_status: z.string().optional(),
  sn: z.string().optional(),
  trade_no: z.string().optional(),
  payway: z.string().optional(),
  total_amount: z.string().optional(),
})

export function makeShouqianbaProvider(deps: ShouqianbaDeps): PaymentProvider {
  const fetchFn = deps.fetchFn ?? fetch
  const { cfg } = deps

  /** API 网关 POST（terminal body 签名）。HTTP/解析失败抛错，业务码由调用方判。 */
  async function post(path: string, payload: Record<string, string>) {
    const { terminalSn, terminalKey } = await deps.getCredentials()
    return await sqbPost(fetchFn, cfg.gateway, path, { terminal_sn: terminalSn, ...payload }, terminalSn, terminalKey)
  }

  return {
    notifyPath: "/shouqianba/notify",

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
      return normalizeResult(biz.data ?? {})
    },

    async refund({ clientSn, refundSn, amountCents }) {
      const json = await post("/upay/v2/refund", {
        client_sn: clientSn,
        refund_request_no: refundSn, // 通道侧幂等键：同号重复请求不重复退
        refund_amount: String(amountCents),
      })
      return { ok: json.result_code === "200" && json.biz_response?.result_code === "REFUND_SUCCESS" }
    },

    parseCallback(rawBody, authorization): CallbackParse {
      if (!verifyRsaCallback(rawBody, authorization, cfg.publicKey)) return { ok: false, error: "bad_signature" }
      let parsed: unknown
      try {
        parsed = JSON.parse(rawBody)
      } catch {
        return { ok: false, error: "bad_body" }
      }
      const cb = callbackSchema.safeParse(parsed)
      if (!cb.success) return { ok: false, error: "bad_body" }
      return { ok: true, clientSn: cb.data.client_sn, result: normalizeResult(cb.data) }
    },
  }
}
