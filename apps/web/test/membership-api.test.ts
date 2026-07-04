import { describe, it, expect } from "bun:test"
import { createMembershipApi } from "../lib/membership-api"

// 记录调用的假 request（不碰全局 fetch；URL/method/body 断言）
function recorder() {
  const calls: { path: string; init?: RequestInit }[] = []
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    calls.push({ path, init })
    return {} as T
  }
  return { calls, api: createMembershipApi(request) }
}

describe("spec308 membership-api 封装", () => {
  it("fetchMembership → GET /api/membership", async () => {
    const { calls, api } = recorder()
    await api.fetchMembership()
    expect(calls[0]!.path).toBe("/api/membership")
    expect(calls[0]!.init?.method ?? "GET").toBe("GET")
  })

  it("fetchCreditTransactions(2,20) 拼 query", async () => {
    const { calls, api } = recorder()
    await api.fetchCreditTransactions(2, 20)
    expect(calls[0]!.path).toBe("/api/credits/transactions?page=2&pageSize=20")
  })

  it("fetchOrders 默认页", async () => {
    const { calls, api } = recorder()
    await api.fetchOrders()
    expect(calls[0]!.path).toBe("/api/orders?page=1&pageSize=20")
  })

  it("startRecharge → POST /api/payment/recharge body {packId,payway}", async () => {
    const { calls, api } = recorder()
    await api.startRecharge("pack-1", "alipay")
    expect(calls[0]!.path).toBe("/api/payment/recharge")
    expect(calls[0]!.init?.method).toBe("POST")
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ packId: "pack-1", payway: "alipay" })
  })

  it("renewMembership → POST /api/membership/renew body {planId,payway}", async () => {
    const { calls, api } = recorder()
    await api.renewMembership("plan-9", "wechat")
    expect(calls[0]!.path).toBe("/api/membership/renew")
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ planId: "plan-9", payway: "wechat" })
  })

  it("请求失败向上抛（401/非2xx 语义由共享 client 决定）", async () => {
    const api = createMembershipApi(async () => {
      throw new Error("boom")
    })
    await expect(api.fetchMembership()).rejects.toThrow("boom")
  })
})
