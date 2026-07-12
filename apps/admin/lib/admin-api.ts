import { adminTokenStore } from "./admin-token-store"
import { camelToSnakeParams, type ModelConfig, type ModelParams } from "./model-config"

// admin API 客户端（spec309）：base /admin-api，Bearer admin token（与 C 端隔离）。
const baseUrl = process.env.NEXT_PUBLIC_ADMIN_API_BASE_URL ?? "/admin-api"

// 带状态码的错误：调用方据此区分 401（会话失效→登出）与瞬时错误（5xx/网络→不登出）。
// code：best-effort 解析出的错误体 { error } 字段（如 models 路由的 chain_requires_tested_models），
// 供需要按错误码区分提示的调用方（如模型管理保存）使用；无法解析时为 undefined。
export class AdminApiError extends Error {
  constructor(public status: number, public code?: string) {
    super(`admin api ${status}`)
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set("Content-Type", "application/json")
  const token = adminTokenStore.get()
  if (token) headers.set("Authorization", `Bearer ${token}`)
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers })
  if (!res.ok) {
    const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined
    throw new AdminApiError(res.status, body?.error)
  }
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
    // 套餐&配置页（spec310）：GET 全量配置 / PUT 单 key（如 agent_model / credit_cost.*，需 config.write）。
    getConfigs: () => req<Record<string, unknown>>("/plans/configs"),
    setConfig: (key: string, value: unknown) =>
      req<{ ok: true }>(`/plans/configs/${key}`, {
        method: "PUT",
        body: JSON.stringify({ value }),
      }),
    // 套餐档位（plans 表，每档每 cycle 一行）：列表 + 改价/额度（需 plan.write）。价格=钱，谨慎。
    list: () => req<ApiPlan[]>("/plans"),
    update: (id: string, patch: { priceCents?: number; grantCreditsPerCycle?: number; status?: string; features?: Record<string, unknown> }) =>
      req<ApiPlan>(`/plans/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
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
    // 后端 RefundBody 字段是 amount（=分）+ idempotencyKey（幂等去重）；此处映射 amountCents→amount。
    refund: (body: { orderId: string; amountCents: number; reason: string; idempotencyKey: string }) =>
      req<{ refundId: string; status: string }>("/refunds", {
        method: "POST",
        body: JSON.stringify({ orderId: body.orderId, amount: body.amountCents, reason: body.reason, idempotencyKey: body.idempotencyKey }),
      }),
  },
  ledger: {
    list: (p: { userId: string; type?: string; page?: number; pageSize?: number }) =>
      req<Paged<ApiLedgerTx>>(`/ledger${qs(p)}`),
    check: (userId: string) => req<{ userId: string; cached: number; actual: number; consistent: boolean }>(`/ledger/${userId}/check`),
  },
  overview: {
    get: () => req<ApiOverview>("/overview"),
    trend: (days = 14) => req<ApiTrendPoint[]>(`/overview/trend?days=${days}`),
  },
  system: {
    admins: (p: { page?: number; pageSize?: number } = {}) => req<Paged<ApiAdmin>>(`/admins${qs(p)}`),
    createAdmin: (body: { username: string; role: string; password: string }) =>
      req<ApiAdmin>("/admins", { method: "POST", body: JSON.stringify(body) }),
    updateAdmin: (id: string, patch: { role?: string; status?: string }) =>
      req<ApiAdmin>(`/admins/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
    auditLogs: (p: { page?: number; pageSize?: number } = {}) => req<Paged<ApiAuditLog>>(`/audit-logs${qs(p)}`),
    rbac: () => req<{ permissions: string[]; roles: Record<string, string[]> }>("/rbac"),
  },
  // 模型管理（spec319 + spec319.1）：GET/PUT 整份 {models,chain}（camelCase），POST /test 单独探测
  // 一个模型（自建端点加 base_url/api_key），POST /list-models 拉自建端点可用模型列表。
  models: {
    get: () => req<ModelConfig>("/models"),
    save: (cfg: ModelConfig) => req<{ ok: true }>("/models", { method: "PUT", body: JSON.stringify(cfg) }),
    // ⚠️ /test 认 snake_case（agent 侧薄中转），PUT 认 camelCase：这里必须转换，否则参数在服务端悄悄变 {}。
    // base_url/api_key 只在自建端点探活时携带；未传（注册表模型）则不下发这两个字段。
    // id：已保存自建条目重测时明文 key 不回显，带 id 让服务端从库里回填 key（否则空 key→假失败）。
    test: (m: { provider: string; model?: string; params?: ModelParams; baseUrl?: string; apiKey?: string; id?: string }) =>
      req<{ ok: boolean; latencyMs?: number; tokens?: number; maxOutput?: number; error?: string }>("/models/test", {
        method: "POST",
        body: JSON.stringify({
          provider: m.provider,
          model: m.model,
          params: m.params ? camelToSnakeParams(m.params) : undefined,
          base_url: m.baseUrl,
          api_key: m.apiKey,
          id: m.id,
        }),
      }),
    // 自建端点 / 内置服务商 连通性探针 + 拉可用模型列表：POST /list-models（camelCase，中转层不转换）。
    // 自建端点带 {baseUrl,apiKey?,id?}——apiKey 缺省时服务端按 id 从库回填 key（已保存条目明文不回显）。
    // 内置服务商（deepseek/qwen/glm）只带 {provider}——服务端从注册表解析 base_url + env 取 key。
    listModels: (m: { baseUrl?: string; apiKey?: string; id?: string; provider?: string }) =>
      req<{ ok: boolean; models?: string[]; error?: string }>("/models/list-models", {
        method: "POST",
        body: JSON.stringify(m),
      }),
  },
}

export type Paged<T> = { items: T[]; total: number; page: number; pageSize: number; hasMore: boolean }
export type ApiUser = { id: string; status: string; nickname: string | null; createdAt: string; phone: string | null; tier: string | null; balance: number }
export type ApiUserDetail = ApiUser & { subscription: { planId: string; status: string; currentPeriodEnd?: string } | null; balance: number }
export type ApiOrder = { id: string; userId: string; type: string; amountCents: number; status: string; provider: string | null; payway: string | null; providerTradeNo: string | null; createdAt: string }
export type ApiLedgerTx = { id: string; userId: string; type: string; amount: number; ref: string | null; createdAt: string; expireAt: string | null }
export type ApiOverview = { totalUsers: number; payingUsers: number; todayRevenueCents: number; creditTxCount: number; creditTxSumToday: number; activeProjects: number }
export type ApiTrendPoint = { date: string; revenue: number; credits: number }
export type ApiAdmin = { id: string; username: string; role: string; status: string; createdAt?: string }
export type ApiAuditLog = { id: string; operator: string; action: string; target: string | null; before: unknown; after: unknown; createdAt: string }
export type ApiPlan = { id: string; name: string; code: string | null; priceCents: number; billingCycle: string; grantCreditsPerCycle: number; status: string; features: Record<string, unknown>; limits: Record<string, unknown> }

// 查询串：跳过 undefined/空，encodeURIComponent。
function qs(p: Record<string, unknown>): string {
  const parts = Object.entries(p)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
  return parts.length ? `?${parts.join("&")}` : ""
}
