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
  }

  return { request, authApi }
}
