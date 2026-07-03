import { md5BodySign } from "./shouqianba-sign"

// 收钱吧非支付接口的公共传输层（terminal 激活/签到 + provider 查询/退款共用）：
// POST JSON + Authorization = <sn> <MD5(body+key)>。HTTP 层失败抛错；业务码语义由调用方判
// （激活/签到要求 result_code=200，查询/退款还要看 biz_response.result_code）。

export type GatewayJson = {
  result_code?: string
  error_message?: string
  biz_response?: {
    result_code?: string
    error_message?: string
    terminal_sn?: string
    terminal_key?: string
    data?: { order_status?: string; sn?: string; trade_no?: string; payway?: string; total_amount?: string }
  }
}

export async function sqbPost(
  fetchFn: typeof fetch,
  gateway: string,
  path: string,
  payload: Record<string, string>,
  sn: string,
  key: string,
): Promise<GatewayJson> {
  const body = JSON.stringify(payload)
  const resp = await fetchFn(`${gateway}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `${sn} ${md5BodySign(body, key)}` },
    body,
  })
  const json = (await resp.json().catch(() => ({}))) as GatewayJson
  if (!resp.ok) throw new Error(`收钱吧网关 HTTP ${resp.status}: ${path} ${json.error_message ?? ""}`)
  return json
}
