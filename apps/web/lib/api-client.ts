export class ApiError extends Error {
  constructor(
    public status: number,
    public code?: string,
    public retryAfter?: number,
  ) {
    super(`API ${status}${code ? " " + code : ""}`)
  }
}

export type ApiClientOptions = {
  baseUrl: string
  getToken: () => string | null
  fetchImpl?: typeof fetch
  // 任意请求返回 401 时回调（令牌失效）——上层用它清令牌 / 复位登录态。
  onUnauthorized?: () => void
}

export function createApiClient(opts: ApiClientOptions) {
  const doFetch = opts.fetchImpl ?? fetch

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers)
    if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json")
    const token = opts.getToken()
    if (token) headers.set("authorization", `Bearer ${token}`)
    const res = await doFetch(`${opts.baseUrl}${path}`, { ...init, headers })
    const raw: unknown = await res.json().catch(() => ({}))
    if (!res.ok) {
      // 仅当请求确实带了令牌时，401 才代表“会话失效”；登录端点（未带令牌）的 401 是登录失败，不该清会话。
      if (res.status === 401 && token) opts.onUnauthorized?.()
      const err = (raw ?? {}) as { error?: string; retryAfter?: number }
      throw new ApiError(res.status, err.error, err.retryAfter)
    }
    return raw as T
  }

  const post = <T>(path: string, data: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(data) })

  const authApi = {
    sendSmsCode: (phone: string, captchaToken?: string) =>
      post<{ ok: true }>("/auth/sms/send", { phone, captchaToken }).then(() => undefined),
    verifySmsCode: (phone: string, code: string, agreedToTerms?: boolean) =>
      post<{ token: string; isNew: boolean; user: { id: string; nickname: string | null } }>(
        "/auth/sms/verify",
        { phone, code, agreedToTerms },
      ),
    me: () => request<{ id: string; nickname: string | null; status: string }>("/auth/me"),
    logout: () => post<{ ok: true }>("/auth/logout", {}).then(() => undefined),
    wechatAuthUrl: (agreedToTerms: boolean) =>
      post<{ state: string; appId: string; scope: string; redirectUri: string }>("/auth/wechat/url", {
        agreedToTerms,
      }),
    wechatLogin: (code: string, state: string) =>
      post<{ token: string; isNew: boolean; user: { id: string; nickname: string | null } }>(
        "/auth/wechat/login",
        { code, state },
      ),
  }

  return { request, authApi }
}
