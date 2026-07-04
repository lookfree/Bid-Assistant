import { z } from "zod"
import { verifyRsaCallback } from "./shouqianba-sign"
import { sqbPost } from "./gateway"
import type { CallbackParse, Payway, PaymentProvider, PaymentResult } from "./provider"

// 收钱吧通道实现（架构 §6.0/§6.1）：无官方 SDK，HTTPS+JSON 直连网关。
// C 扫 B 预下单/查询/退款均走 API 网关 + terminal body 签名（Task4 真实冒烟校验通过：
// precreate 返回 qr_code，query/refund 契约见各方法）；回调用收钱吧公钥 RSA 验签。

export type ShouqianbaConfig = {
  gateway: string // API 网关 https://vsi-api.shouqianba.com
  publicKey: string // 收钱吧回调验签公钥（PEM）
}

// 付款钱包 → 收钱吧 payway 整数码（Task4 冒烟确认：必填整数，1=支付宝 3=微信）
const PAYWAY_CODE: Record<Payway, string> = { alipay: "1", wechat: "3" }

export type ShouqianbaDeps = {
  cfg: ShouqianbaConfig
  /** 终端凭证（terminal.ts 提供；测试注入固定值） */
  getCredentials: () => Promise<{ terminalSn: string; terminalKey: string }>
  fetchFn?: typeof fetch
}

// order_status → PaymentResult.status 映射；未知状态一律 pending（钱可能已付，不敢判 failed）
const FAILED_STATUSES = new Set(["CANCELED", "PAY_CANCELED", "EXPIRED", "PAY_ERROR"])
const REFUNDED_STATUSES = new Set(["REFUNDED", "PARTIAL_REFUNDED"]) // 通道侧已退款（对账核对退款单）

/** 通道报文 → PaymentResult 归一（查询响应与回调共用：金额转整数分只在这一处）。 */
function normalizeResult(d: { order_status?: string; sn?: string; trade_no?: string; payway?: string; total_amount?: string }): PaymentResult {
  const status: PaymentResult["status"] =
    d.order_status === "PAID"
      ? "paid"
      : REFUNDED_STATUSES.has(d.order_status ?? "")
        ? "refunded"
        : FAILED_STATUSES.has(d.order_status ?? "")
          ? "failed"
          : "pending"
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
      // C 扫 B 预下单：返回顾客扫的二维码（qr_code 原文 + 现成图片 URL）
      const json = await post("/upay/v2/precreate", {
        client_sn: opts.clientSn, // ≤32 字符（createOrder 保证）
        total_amount: String(opts.amountCents), // 单位分
        subject: opts.subject,
        payway: PAYWAY_CODE[opts.payway],
        operator: "bidsaas",
        notify_url: opts.notifyUrl,
      })
      const biz = json.biz_response
      if (json.result_code !== "200" || biz?.result_code !== "PRECREATE_SUCCESS") {
        throw new Error(`收钱吧预下单失败: ${json.result_code} ${biz?.error_message ?? ""}`)
      }
      const data = biz.data ?? {}
      if (!data.qr_code) throw new Error("收钱吧预下单成功但缺 qr_code")
      return { qrCode: data.qr_code, qrImageUrl: data.qr_code_image_url }
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
