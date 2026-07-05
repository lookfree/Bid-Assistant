import { adminTokenStore } from "./admin-token-store"

// admin API 客户端（spec309）：base /admin-api，Bearer admin token（与 C 端隔离）。
const baseUrl = process.env.NEXT_PUBLIC_ADMIN_API_BASE_URL ?? "/admin-api"

// 带状态码的错误：调用方据此区分 401（会话失效→登出）与瞬时错误（5xx/网络→不登出）。
export class AdminApiError extends Error {
  constructor(public status: number) {
    super(`admin api ${status}`)
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set("Content-Type", "application/json")
  const token = adminTokenStore.get()
  if (token) headers.set("Authorization", `Bearer ${token}`)
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers })
  if (!res.ok) throw new AdminApiError(res.status)
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

export type AdminMe = { id: string; username: string; role: string; status: string }

export const adminApi = {
  login: (username: string, password: string) =>
    req<{ token: string; admin: { id: string; username: string; role: string } }>("/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  me: () => req<{ admin: AdminMe }>("/me"),
  logout: () => req<void>("/logout", { method: "POST" }),
  plans: {
    // 套餐&配置页（spec310）：GET 全量配置 / PUT 单 key（如 agent_model，需 config.write）。
    getConfigs: () => req<Record<string, unknown>>("/plans/configs"),
    setConfig: (key: string, value: unknown) =>
      req<{ ok: true }>(`/plans/configs/${key}`, {
        method: "PUT",
        body: JSON.stringify({ value }),
      }),
  },
  // 以下为真实数据接线（spec312）：dev/test 不再用 mock。返回体统一分页 { items,total,page,pageSize,hasMore }。
  users: {
    list: (p: { q?: string; page?: number; pageSize?: number } = {}) =>
      req<Paged<ApiUser>>(`/users${qs(p)}`),
    detail: (id: string) => req<ApiUserDetail>(`/users/${id}`),
    ban: (id: string) => req<{ ok: true }>(`/users/${id}/ban`, { method: "POST" }),
    unban: (id: string) => req<{ ok: true }>(`/users/${id}/unban`, { method: "POST" }),
    grantCredits: (id: string, body: { amount: number; reason: string; idempotencyKey: string }) =>
      req<{ balance: number }>(`/users/${id}/credits`, { method: "POST", body: JSON.stringify(body) }),
  },
  orders: {
    list: (p: { status?: string; type?: string; userId?: string; page?: number; pageSize?: number } = {}) =>
      req<Paged<ApiOrder>>(`/orders${qs(p)}`),
    detail: (id: string) => req<ApiOrder & { refunds: unknown[] }>(`/orders/${id}`),
    refund: (body: { orderId: string; amountCents: number; reason: string; idempotencyKey: string }) =>
      req<{ ok: true }>("/refunds", { method: "POST", body: JSON.stringify(body) }),
  },
  ledger: {
    list: (p: { userId: string; type?: string; page?: number; pageSize?: number }) =>
      req<Paged<ApiLedgerTx>>(`/ledger${qs(p)}`),
    check: (userId: string) => req<{ cached: number; actual: number; match: boolean }>(`/ledger/${userId}/check`),
  },
  overview: () => req<ApiOverview>("/overview"),
}

export type Paged<T> = { items: T[]; total: number; page: number; pageSize: number; hasMore: boolean }
export type ApiUser = { id: string; status: string; nickname: string | null; createdAt: string; phone: string | null; tier: string | null; balance: number }
export type ApiUserDetail = ApiUser & { subscription: { planId: string; status: string; currentPeriodEnd?: string } | null; balance: number }
export type ApiOrder = { id: string; userId: string; type: string; amountCents: number; status: string; provider: string | null; payway: string | null; providerTradeNo: string | null; createdAt: string }
export type ApiLedgerTx = { id: string; userId: string; type: string; amount: number; ref: string | null; createdAt: string; expireAt: string | null }
export type ApiOverview = { totalUsers: number; payingUsers: number; todayRevenueCents: number; creditTxCount: number; creditTxSumToday: number; activeProjects: number }

// 查询串：跳过 undefined/空，encodeURIComponent。
function qs(p: Record<string, unknown>): string {
  const parts = Object.entries(p)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
  return parts.length ? `?${parts.join("&")}` : ""
}
