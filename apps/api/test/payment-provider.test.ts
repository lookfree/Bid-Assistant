import { describe, it, expect } from "bun:test"
import { createSign, generateKeyPairSync } from "node:crypto"
import { md5BodySign, wap2Sign } from "../src/services/payment/shouqianba-sign"
import { makeShouqianbaProvider } from "../src/services/payment/shouqianba"

// ShouqianbaProvider 四方法（mock 网关，不打网络、不连 DB——凭证注入）。

const creds = { terminalSn: "TSN9", terminalKey: "tkey9" }
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString()

type Captured = { url: string; auth: string; body: string }
function fakeGateway(responses: Array<Record<string, unknown>>) {
  const calls: Captured[] = []
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), auth: String((init?.headers as Record<string, string>)?.["Authorization"]), body: String(init?.body) })
    return new Response(JSON.stringify(responses.shift()), { status: 200 })
  }) as typeof fetch
  return { calls, fetchFn }
}

function makeProvider(responses: Array<Record<string, unknown>> = []) {
  const { calls, fetchFn } = fakeGateway(responses)
  const provider = makeShouqianbaProvider({
    cfg: { gateway: "https://sqb.test", wapGateway: "https://wap.test/gateway", publicKey: publicPem },
    getCredentials: async () => creds,
    fetchFn,
  })
  return { provider, calls }
}

describe("createPayment（WAP2 跳转支付 URL）", () => {
  it("URL 含全部必备参数，sign 可用 wap2Sign 复算一致", async () => {
    const { provider } = makeProvider()
    const { payUrl } = await provider.createPayment({
      clientSn: "order-1",
      amountCents: 100,
      subject: "积分充值",
      returnUrl: "https://app.test/pay/return",
      notifyUrl: "https://app.test/api/payment/shouqianba/notify",
    })
    const u = new URL(payUrl)
    expect(payUrl.startsWith("https://wap.test/gateway?")).toBe(true)
    const q = Object.fromEntries(u.searchParams)
    expect(q.terminal_sn).toBe("TSN9")
    expect(q.client_sn).toBe("order-1")
    expect(q.total_amount).toBe("100") // 单位分，整数字符串
    expect(q.subject).toBe("积分充值")
    expect(q.return_url).toBe("https://app.test/pay/return")
    expect(q.notify_url).toBe("https://app.test/api/payment/shouqianba/notify")
    // 签名可复算：对除 sign 外的全部参数用 terminal_key 做 wap2Sign
    const { sign, ...rest } = q
    expect(sign).toBe(wap2Sign(rest, "tkey9"))
  })
})

describe("query（轮询/对账共用）", () => {
  const queryResp = (order_status: string) => ({
    result_code: "200",
    biz_response: { result_code: "SUCCESS", data: { order_status, sn: "7800001", trade_no: "wx-123", payway: "3" } },
  })

  it("terminal 签名请求，PAID → paid + 带 sn/trade_no/payway", async () => {
    const { provider, calls } = makeProvider([queryResp("PAID")])
    const r = await provider.query("order-1")
    expect(r).toEqual({ status: "paid", sn: "7800001", tradeNo: "wx-123", payway: "3" })
    const req = calls[0]!
    expect(JSON.parse(req.body)).toEqual({ terminal_sn: "TSN9", client_sn: "order-1" })
    expect(req.auth).toBe(`TSN9 ${md5BodySign(req.body, "tkey9")}`)
  })

  it("CANCELED/EXPIRED/PAY_CANCELED → failed；CREATED/IN_PROGRESS → pending", async () => {
    for (const s of ["CANCELED", "EXPIRED", "PAY_CANCELED", "PAY_ERROR"]) {
      const { provider } = makeProvider([queryResp(s)])
      expect((await provider.query("o")).status).toBe("failed")
    }
    for (const s of ["CREATED", "PAY_IN_PROGRESS"]) {
      const { provider } = makeProvider([queryResp(s)])
      expect((await provider.query("o")).status).toBe("pending")
    }
  })
})

describe("refund", () => {
  it("带 refund_request_no（幂等键）terminal 签名；成功 → ok:true", async () => {
    const { provider, calls } = makeProvider([
      { result_code: "200", biz_response: { result_code: "REFUND_SUCCESS", data: {} } },
    ])
    const r = await provider.refund({ clientSn: "order-1", refundSn: "refund-1", amountCents: 100 })
    expect(r.ok).toBe(true)
    const body = JSON.parse(calls[0]!.body)
    expect(body.client_sn).toBe("order-1")
    expect(body.refund_request_no).toBe("refund-1")
    expect(body.refund_amount).toBe("100")
    expect(calls[0]!.auth).toBe(`TSN9 ${md5BodySign(calls[0]!.body, "tkey9")}`)
  })

  it("网关业务失败 → ok:false（不抛，调用方决定重试/告警）", async () => {
    const { provider } = makeProvider([{ result_code: "200", biz_response: { result_code: "FAIL", error_message: "余额不足" } }])
    expect((await provider.refund({ clientSn: "o", refundSn: "r", amountCents: 1 })).ok).toBe(false)
  })
})

describe("verifyCallback", () => {
  it("直通 RSA 验签：正签通过、篡改失败", async () => {
    const { provider } = makeProvider()
    const body = '{"client_sn":"order-1","order_status":"PAID"}'
    const sig = createSign("RSA-SHA256").update(body, "utf8").sign(privateKey, "base64")
    expect(provider.verifyCallback(body, sig)).toBe(true)
    expect(provider.verifyCallback(body.replace("PAID", "FAKE"), sig)).toBe(false)
  })
})
