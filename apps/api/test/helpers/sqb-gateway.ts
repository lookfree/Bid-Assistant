import { createSign, generateKeyPairSync } from "node:crypto"
import { makeShouqianbaProvider } from "../../src/services/payment/shouqianba"
import type { PaymentProvider } from "../../src/services/payment/provider"

// 收钱吧 mock 网关（payment-terminal / payment-provider 测试共用）：
// 记录每次请求（url/Authorization/body），按序返回 canned 响应；条目为 Error 时模拟网络异常。
export type CapturedRequest = { url: string; auth: string; body: string }

/** 全量桩 provider：按需覆写个别方法（payment-orders / payment-routes 测试共用）。 */
export function stubProvider(overrides: Partial<PaymentProvider> = {}): PaymentProvider {
  return {
    notifyPath: "/shouqianba/notify",
    createPayment: async () => {
      throw new Error("not used")
    },
    query: async () => ({ status: "pending" }),
    refund: async () => ({ ok: false }),
    parseCallback: () => ({ ok: false, error: "bad_signature" }),
    ...overrides,
  }
}

export function fakeGateway(responses: Array<Record<string, unknown> | Error>) {
  const calls: CapturedRequest[] = []
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({
      url: String(url),
      auth: String(init?.headers && (init.headers as Record<string, string>)["Authorization"]),
      body: String(init?.body),
    })
    const next = responses.shift()
    if (next instanceof Error) throw next
    return new Response(JSON.stringify(next), { status: 200 })
  }) as typeof fetch
  return { calls, fetchFn }
}

/** 真 ShouqianbaProvider + 配套 RSA 签名器（payment-routes / membership-renew 共用）：
 *  路由测试走生产解析/验签路径，不手抄 mock。 */
export function makeSignedProvider(tag: string) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const provider = makeShouqianbaProvider({
    cfg: {
      gateway: "https://sqb.test",
      wapGateway: "https://wap.test/gateway",
      publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    },
    getCredentials: async () => ({ terminalSn: `TSN-${tag}`, terminalKey: `tkey-${tag}` }),
  })
  const signOf = (body: string) => createSign("RSA-SHA256").update(body, "utf8").sign(privateKey, "base64")
  return { provider, signOf }
}
