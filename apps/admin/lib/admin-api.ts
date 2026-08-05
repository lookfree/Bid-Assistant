import { adminTokenStore } from "./admin-token-store"
import { camelToSnakeParams, type ModelConfig, type ModelParams } from "./model-config"

// admin API 客户端（spec309）：base /admin-api，Bearer admin token（与 C 端隔离）。
const baseUrl = process.env.NEXT_PUBLIC_ADMIN_API_BASE_URL ?? "/admin-api"

// 带状态码的错误：调用方据此区分 401（会话失效→登出）与瞬时错误（5xx/网络→不登出）。
// code：best-effort 解析出的错误体 { error } 字段（如 models 路由的 chain_requires_tested_models），
// 供需要按错误码区分提示的调用方（如模型管理保存）使用；无法解析时为 undefined。
export class AdminApiError extends Error {
  constructor(public status: number, public code?: string, public detail?: string, public entryId?: string) {
    // message 优先用服务端给的原因：退款等接口把可读中文原因放在 body.error，
    // 只显示「admin api 422」等于把唯一有用的信息丢掉，运营根本不知道该怎么办（生产实测）。
    // detail/entryId（2026-08-02）：服务端校验/测活失败的具体原因与条目 id,展示层拼具体文案。
    super(code || `admin api ${status}`)
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  // FormData（文件上传）让浏览器自带 multipart boundary，勿覆盖成 application/json。
  if (!(init?.body instanceof FormData)) headers.set("Content-Type", "application/json")
  const token = adminTokenStore.get()
  if (token) headers.set("Authorization", `Bearer ${token}`)
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers })
  if (!res.ok) {
    const body = (await res.json().catch(() => undefined)) as { error?: string; detail?: string; id?: string } | undefined
    throw new AdminApiError(res.status, body?.error, body?.detail, body?.id)
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

export type AdminMe = { id: string; username: string; role: string; status: string; permissions?: string[] }

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
    /** 运营备注（后台专用，C 端看不到）：空串=清空 */
    setNote: (id: string, note: string) =>
      req<{ adminNote: string | null }>(`/users/${id}/note`, { method: "PATCH", body: JSON.stringify({ note }) }),
  },
  orders: {
    list: (p: { status?: string; type?: string; userId?: string; page?: number; pageSize?: number } = {}) =>
      req<Paged<ApiOrder>>(`/orders${qs(p)}`),
    detail: (id: string) => req<ApiOrder & { refunds: unknown[] }>(`/orders/${id}`),
    // 后端 RefundBody 字段是 amount（=分）+ idempotencyKey（幂等去重）；此处映射 amountCents→amount。
    // allowNegativeBalance：退款要按比例扣回当初送出的积分，用户已消费时扣不动——后端护栏默认拒绝
    // 并要求操作员显式确认。此前后台没有这个出口，于是「充值送的积分一旦被花掉，这笔订单永远退不了」
    // （生产实测：同一订单连续 4 次 422）。
    refund: (body: { orderId: string; amountCents: number; reason: string; idempotencyKey: string; allowNegativeBalance?: boolean }) =>
      req<{ refundId: string; status: "done" | "failed" | "pending"; reason?: string }>("/refunds", {
        method: "POST",
        body: JSON.stringify({
          orderId: body.orderId, amount: body.amountCents, reason: body.reason,
          idempotencyKey: body.idempotencyKey,
          ...(body.allowNegativeBalance ? { allowNegativeBalance: true } : {}),
        }),
      }),
  },
  ledger: {
    // userId 省略 = 全部用户（每行带 userName，见 services/admin/ledger.ts）
    list: (p: { userId?: string; type?: string; page?: number; pageSize?: number }) =>
      req<Paged<ApiLedgerTx>>(`/ledger${qs(p)}`),
    check: (userId: string) => req<{ userId: string; cached: number; actual: number; consistent: boolean }>(`/ledger/${userId}/check`),
    // 账本页用户选择器（权限随本页 ledger.read;昵称/打码手机号,不含完整用户信息）
    userOptions: () => req<{ items: { id: string; name: string }[] }>(`/ledger/user-options`),
  },
  overview: {
    get: () => req<ApiOverview>("/overview"),
    trend: (days = 14) => req<ApiTrendPoint[]>(`/overview/trend?days=${days}`),
  },
  system: {
    admins: (p: { page?: number; pageSize?: number } = {}) => req<Paged<ApiAdmin>>(`/admins${qs(p)}`),
    createAdmin: (body: { username: string; role: string; password: string }) =>
      req<ApiAdmin>("/admins", { method: "POST", body: JSON.stringify(body) }),
    updateAdmin: (id: string, patch: { role?: string; status?: string; password?: string }) =>
      req<ApiAdmin>(`/admins/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
    auditLogs: (p: { page?: number; pageSize?: number } = {}) => req<Paged<ApiAuditLog>>(`/audit-logs${qs(p)}`),
    rbac: () => req<{ permissions: string[]; roles: Record<string, string[]>; editableRoles: string[] }>("/rbac"),
    saveRbac: (roles: Record<string, string[]>) =>
      req<{ ok: boolean }>("/rbac", { method: "PUT", body: JSON.stringify(roles) }),
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
  // 反馈工单（spec326 备案合规）：列表按 status 筛选 + 分页（feedback.read）；
  // handle 标记处理中/已解决 + 可选回复（feedback.write，support/ops/superadmin 可用，finance 403）。
  feedback: {
    list: (p: { status?: string; page?: number; pageSize?: number }) =>
      req<Paged<ApiFeedback>>(`/feedback${qs(p)}`),
    handle: (id: string, patch: { status: "processing" | "resolved"; reply?: string }) =>
      req<ApiFeedback>(`/feedback/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  },
  // 标书分类纠偏（spec334）：只读。判定质量的唯一反馈回路——没有它，同一个判错会被一百个用户
  // 各纠一次，而我们一次都不知道。
  bidCategories: {
    corrections: (p: { page?: number; pageSize?: number } = {}) =>
      req<Paged<ApiCategoryCorrection>>(`/bid-categories/corrections${qs(p)}`),
    summary: () => req<{ items: ApiCategorySummaryRow[] }>(`/bid-categories/corrections/summary`),
  },
  // 发票管理（spec332）：列表按 status/userId 筛选（invoice.write）；handle 开具/驳回，落审计。
  invoices: {
    list: (p: { status?: string; userId?: string; page?: number; pageSize?: number } = {}) =>
      req<Paged<ApiInvoice>>(`/invoices${qs(p)}`),
    handle: (id: string, body: { action: "issue"; invoiceNo: string; fileKey: string } | { action: "reject"; reason: string }) =>
      req<ApiInvoice>(`/invoices/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    // 上传电子发票文件（multipart，经 API 中转直传 MinIO）；返回对象 key，随开具回填。
    uploadFile: (id: string, file: File) => {
      const fd = new FormData()
      fd.append("file", file)
      return req<{ key: string }>(`/invoices/${id}/file`, { method: "POST", body: fd })
    },
  },
}

export type Paged<T> = { items: T[]; total: number; page: number; pageSize: number; hasMore: boolean }
export type ApiUser = { id: string; status: string; nickname: string | null; adminNote: string | null; createdAt: string; phone: string | null; tier: string | null; balance: number }
export type ApiUserDetail = ApiUser & { subscription: { planId: string; status: string; currentPeriodEnd?: string } | null; balance: number }
export type ApiOrder = { id: string; userId: string; type: string; amountCents: number; status: string; provider: string | null; payway: string | null; providerTradeNo: string | null; createdAt: string }
export type ApiLedgerTx = { id: string; userId: string; userName?: string; type: string; amount: number; ref: string | null; createdAt: string; expireAt: string | null }
export type ApiOverview = {
  totalUsers: number
  payingUsers: number
  /** 累计实收（已支付订单额 − 已完成退款额） */
  totalRevenueCents: number
  todayRevenueCents: number
  creditTxCount: number
  creditTxSumToday: number
  activeProjects: number
}
export type ApiTrendPoint = { date: string; revenue: number; credits: number }
export type ApiAdmin = { id: string; username: string; role: string; status: string; createdAt?: string }
export type ApiAuditLog = { id: string; operator: string; action: string; target: string | null; before: unknown; after: unknown; createdAt: string }
export type ApiPlan = { id: string; name: string; code: string | null; priceCents: number; billingCycle: string; grantCreditsPerCycle: number; status: string; features: Record<string, unknown>; limits: Record<string, unknown> }
export type ApiFeedback = { id: string; userId: string; type: "content_error" | "complaint" | "billing" | "suggestion" | "other"; projectId: string | null; content: string; contact: string | null; status: "pending" | "processing" | "resolved"; reply: string | null; handledBy: string | null; handledAt: string | null; createdAt: string; nickname: string | null }
export type ApiInvoice = { id: string; userId: string; orderId: string; amountCents: number; titleType: "personal" | "enterprise"; title: string; taxNo: string | null; email: string | null; remark: string | null; status: "pending" | "issued" | "rejected"; invoiceNo: string | null; fileKey: string | null; rejectReason: string | null; handledBy: string | null; handledAt: string | null; createdAt: string }
// email 为历史字段（改站内下载后新申请不再收集，可空）
// 分类纠偏样本（spec334）：detected 是系统判的，confirmed 是用户改成的；两者都是 1–2 个值的
// 有序数组，首元素为主类别。**只有「判过且被改」才会有记录**——没判过时的用户选择不算纠偏。
export type ApiCategoryCorrection = { id: string; projectId: string; projectName: string | null; detected: string[]; confirmed: string[]; confidence: string | null; createdAt: string }
export type ApiCategorySummaryRow = { detected: string; confirmed: string; count: number }

// 查询串：跳过 undefined/空，encodeURIComponent。
function qs(p: Record<string, unknown>): string {
  const parts = Object.entries(p)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
  return parts.length ? `?${parts.join("&")}` : ""
}
