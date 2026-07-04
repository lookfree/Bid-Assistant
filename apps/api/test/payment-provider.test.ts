import { describe, it, expect } from "bun:test"
import { createSign, generateKeyPairSync } from "node:crypto"
import { md5BodySign } from "../src/services/payment/shouqianba-sign"
import { makeShouqianbaProvider } from "../src/services/payment/shouqianba"
import { fakeGateway } from "./helpers/sqb-gateway"

// ShouqianbaProvider 四方法（mock 网关，不打网络、不连 DB——凭证注入）。

const creds = { terminalSn: "TSN9", terminalKey: "tkey9" }
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString()

function makeProvider(responses: Array<Record<string, unknown>> = []) {
  const { calls, fetchFn } = fakeGateway(responses)
  const provider = makeShouqianbaProvider({
    cfg: { gateway: "https://sqb.test", publicKey: publicPem },
    getCredentials: async () => creds,
    fetchFn,
  })
  return { provider, calls }
}

describe("createPayment（C 扫 B 预下单 /upay/v2/precreate → qr_code）", () => {
  const precreateResp = {
    result_code: "200",
    biz_response: { result_code: "PRECREATE_SUCCESS", data: { order_status: "CREATED", qr_code: "https://qr.alipay.com/abc", qr_code_image_url: "https://api.shouqianba.com/upay/qrcode?content=x" } },
  }

  it("payway=alipay → 请求带整数码 1、terminal 签名，返回 qrCode + qrImageUrl", async () => {
    const { provider, calls } = makeProvider([precreateResp])
    const r = await provider.createPayment({
      clientSn: "order-1",
      amountCents: 100,
      subject: "积分充值",
      payway: "alipay",
      notifyUrl: "https://app.test/api/payment/shouqianba/notify",
    })
    expect(r).toEqual({ qrCode: "https://qr.alipay.com/abc", qrImageUrl: "https://api.shouqianba.com/upay/qrcode?content=x" })
    const req = calls[0]!
    expect(req.url).toBe("https://sqb.test/upay/v2/precreate")
    const body = JSON.parse(req.body)
    expect(body).toEqual({
      terminal_sn: "TSN9",
      client_sn: "order-1",
      total_amount: "100",
      subject: "积分充值",
      payway: "1", // 支付宝
      operator: "bidsaas",
      notify_url: "https://app.test/api/payment/shouqianba/notify",
    })
    expect(req.auth).toBe(`TSN9 ${md5BodySign(req.body, "tkey9")}`)
  })

  it("payway=wechat → 整数码 3", async () => {
    const { provider, calls } = makeProvider([precreateResp])
    await provider.createPayment({ clientSn: "o", amountCents: 1, subject: "s", payway: "wechat", notifyUrl: "n" })
    expect(JSON.parse(calls[0]!.body).payway).toBe("3")
  })

  it("预下单业务失败 → 抛错（不静默）", async () => {
    const { provider } = makeProvider([{ result_code: "400", error_code: "INVALID_PARAMS", biz_response: null }])
    await expect(provider.createPayment({ clientSn: "o", amountCents: 1, subject: "s", payway: "alipay", notifyUrl: "n" })).rejects.toThrow(/预下单失败/)
  })
})

describe("query（轮询/对账共用）", () => {
  const queryResp = (order_status: string) => ({
    result_code: "200",
    biz_response: { result_code: "SUCCESS", data: { order_status, sn: "7800001", trade_no: "wx-123", payway: "3", total_amount: "100" } },
  })

  it("terminal 签名请求，PAID → paid + 带 sn/trade_no/payway/实付金额", async () => {
    const { provider, calls } = makeProvider([queryResp("PAID")])
    const r = await provider.query("order-1")
    expect(r).toEqual({ status: "paid", sn: "7800001", tradeNo: "wx-123", payway: "3", totalAmountCents: 100 })
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

describe("parseCallback（验签 + 报文归一，路由不碰线格式）", () => {
  const sign = (body: string) => createSign("RSA-SHA256").update(body, "utf8").sign(privateKey, "base64")

  it("RSA 验签：篡改 body 即拒（bad_signature）", () => {
    const { provider } = makeProvider()
    const body = '{"client_sn":"order-1","order_status":"PAID"}'
    const sig = sign(body)
    expect(provider.parseCallback(body, sig).ok).toBe(true)
    expect(provider.parseCallback(body.replace("PAID", "FAKE"), sig)).toEqual({ ok: false, error: "bad_signature" })
  })

  it("正签 PAID 报文 → ok + PaymentResult（金额归一整数分）", () => {
    const { provider } = makeProvider()
    const body = JSON.stringify({ client_sn: "order-9", order_status: "PAID", sn: "780", trade_no: "wx-9", payway: "3", total_amount: "100" })
    const parsed = provider.parseCallback(body, sign(body))
    expect(parsed).toEqual({
      ok: true,
      clientSn: "order-9",
      result: { status: "paid", sn: "780", tradeNo: "wx-9", payway: "3", totalAmountCents: 100 },
    })
  })

  it("total_amount 缺失/非数字 → totalAmountCents undefined（markPaid 端按 amount_missing 拒入账）", () => {
    const { provider } = makeProvider()
    const body = JSON.stringify({ client_sn: "order-9", order_status: "PAID", total_amount: "abc" })
    const parsed = provider.parseCallback(body, sign(body))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.result.totalAmountCents).toBeUndefined()
  })

  it("坏签名 → bad_signature；签名对但 body 非法 → bad_body", () => {
    const { provider } = makeProvider()
    const body = JSON.stringify({ client_sn: "order-9", order_status: "PAID" })
    expect(provider.parseCallback(body, "not-a-sig")).toEqual({ ok: false, error: "bad_signature" })
    const junk = "not-json"
    expect(provider.parseCallback(junk, sign(junk))).toEqual({ ok: false, error: "bad_body" })
    const noSn = JSON.stringify({ order_status: "PAID" })
    expect(provider.parseCallback(noSn, sign(noSn))).toEqual({ ok: false, error: "bad_body" })
  })
})
