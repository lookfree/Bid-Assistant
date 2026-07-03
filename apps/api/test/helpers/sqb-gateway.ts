// 收钱吧 mock 网关（payment-terminal / payment-provider 测试共用）：
// 记录每次请求（url/Authorization/body），按序返回 canned 响应；条目为 Error 时模拟网络异常。
export type CapturedRequest = { url: string; auth: string; body: string }

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
