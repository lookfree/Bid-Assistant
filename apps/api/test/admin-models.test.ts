import { describe, it, expect, afterAll, setDefaultTimeout } from "bun:test"
import { Hono } from "hono"
import { adminRoutes } from "../src/routes/admin"
import { getDb, closeDb } from "../src/db/client"
import { adminUsers, billingConfigs } from "../src/db/schema"
import { eq } from "drizzle-orm"
import { makeAdminSession, TEST_TIMEOUT_MS } from "./repos/helpers"
import { getModelConfig } from "../src/services/model-config"

// admin-api /models 路由（spec319 Task B）—— 连真库+admin 鉴权，跑法：
// ./test-on-mbp.sh test/admin-models.test.ts
setDefaultTimeout(TEST_TIMEOUT_MS)

const app = new Hono()
app.route("/admin-api", adminRoutes())
const madeAdmins: string[] = []
const regA = (id: string) => madeAdmins.push(id)
// billing_configs.value 是 NOT NULL：模拟"未配置"用删行，不能 setConfig(key, undefined/null)。
const clearAgentModel = () => getDb().delete(billingConfigs).where(eq(billingConfigs.key, "agent_model"))

afterAll(async () => {
  for (const id of madeAdmins) await getDb().delete(adminUsers).where(eq(adminUsers.id, id))
  await clearAgentModel()
  await closeDb()
})

describe("spec319 /admin-api/models", () => {
  it("GET 返回当前配置（空 → {models:[],chain:[]}）", async () => {
    await clearAgentModel()
    const { headers } = await makeAdminSession("ops", regA)
    const res = await app.request("http://x/admin-api/models", { headers })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ models: [], chain: [] })
  })

  it("PUT chain 引用未测通 model → 400 chain_requires_tested_models，不落库", async () => {
    await clearAgentModel()
    const { headers } = await makeAdminSession("ops", regA)
    const body = {
      models: [{ id: "m1", provider: "deepseek", model: "deepseek-chat", params: { temperature: 0.7, maxTokens: 8192, topP: 1 }, enabled: true, test: { status: "untested" } }],
      chain: ["m1"],
    }
    const res = await app.request("http://x/admin-api/models", { method: "PUT", headers, body: JSON.stringify(body) })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "chain_requires_tested_models" })
    const after = await app.request("http://x/admin-api/models", { headers })
    expect(await after.json()).toEqual({ models: [], chain: [] })
  })

  it("PUT 全合法 → 200 落库", async () => {
    const { headers } = await makeAdminSession("ops", regA)
    const body = {
      models: [{ id: "m1", provider: "deepseek", model: "deepseek-chat", params: { temperature: 0.7, maxTokens: 8192, topP: 1 }, enabled: true, test: { status: "passed" } }],
      chain: ["m1"],
    }
    const res = await app.request("http://x/admin-api/models", { method: "PUT", headers, body: JSON.stringify(body) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it("support 角色 PUT → 403（无 config.write）", async () => {
    const { headers } = await makeAdminSession("support", regA)
    const res = await app.request("http://x/admin-api/models", { method: "PUT", headers, body: JSON.stringify({ models: [], chain: [] }) })
    expect(res.status).toBe(403)
  })

  it("POST /test 透传 agent 连通性测试结果（mock fetch）", async () => {
    const { headers } = await makeAdminSession("ops", regA)
    const orig = (globalThis as any).fetch
    ;(globalThis as any).fetch = (async () => new Response(JSON.stringify({ ok: true, latency_ms: 88, tokens: 12 }), { status: 200 })) as unknown as typeof fetch
    try {
      const res = await app.request("http://x/admin-api/models/test", { method: "POST", headers, body: JSON.stringify({ provider: "deepseek" }) })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, latencyMs: 88, tokens: 12 })
    } finally {
      ;(globalThis as any).fetch = orig
    }
  })

  it("POST /list-models 中转 agent（mock fetch），原样返回 {ok, models}", async () => {
    const { headers } = await makeAdminSession("ops", regA)
    const orig = (globalThis as any).fetch
    let capturedBody: any
    ;(globalThis as any).fetch = (async (_url: string, init: any) => {
      capturedBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ ok: true, models: ["qwen2.5-72b", "qwen2.5-7b"] }), { status: 200 })
    }) as unknown as typeof fetch
    try {
      const res = await app.request("http://x/admin-api/models/list-models", {
        method: "POST",
        headers,
        body: JSON.stringify({ baseUrl: "http://h:8000/v1", apiKey: "sk-x" }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, models: ["qwen2.5-72b", "qwen2.5-7b"] })
      expect(capturedBody).toEqual({ base_url: "http://h:8000/v1", api_key: "sk-x" })
    } finally {
      ;(globalThis as any).fetch = orig
    }
  })

  // 内置服务商拉取（本次新增）：带 provider、不带 baseUrl ⇒ 中转 {provider} 给 agent，不走自建端点 key 解析。
  it("POST /list-models 带 {provider} 中转 agent（mock fetch），原样返回 {ok, models}", async () => {
    const { headers } = await makeAdminSession("ops", regA)
    const orig = (globalThis as any).fetch
    let capturedBody: any
    ;(globalThis as any).fetch = (async (_url: string, init: any) => {
      capturedBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ ok: true, models: ["deepseek-chat", "deepseek-reasoner"] }), { status: 200 })
    }) as unknown as typeof fetch
    try {
      const res = await app.request("http://x/admin-api/models/list-models", {
        method: "POST",
        headers,
        body: JSON.stringify({ provider: "deepseek" }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, models: ["deepseek-chat", "deepseek-reasoner"] })
      expect(capturedBody).toEqual({ provider: "deepseek" })
    } finally {
      ;(globalThis as any).fetch = orig
    }
  })

  // 密钥策略核心回归（REQUIRED）：GET 从不回显明文 key；PUT 携带空 apiKey 时保留库里旧 key（按 id 合并）。
  it("自建条目密钥往返：PUT 建自建带 key → GET 打码不回显明文 → PUT 回去 key 留空 → 库里 key 不变", async () => {
    await clearAgentModel()
    const { headers } = await makeAdminSession("ops", regA)
    const custom = {
      id: "c1",
      provider: "custom",
      model: "qwen-x",
      params: { temperature: 0.7, maxTokens: 8192, topP: 1 },
      enabled: true,
      test: { status: "passed" as const },
      baseUrl: "http://h:8000/v1",
      apiKey: "sk-secret-real",
    }
    const putRes1 = await app.request("http://x/admin-api/models", {
      method: "PUT",
      headers,
      body: JSON.stringify({ models: [custom], chain: ["c1"] }),
    })
    expect(putRes1.status).toBe(200)

    const getRes = await app.request("http://x/admin-api/models", { headers })
    const got = (await getRes.json()) as any
    expect(got.models[0].apiKey).toBeUndefined()
    expect(JSON.stringify(got)).not.toContain("sk-secret-real")
    expect(got.models[0].apiKeyHint).toBe("sk-****al")

    // 用 GET 回来的（打码、无明文 apiKey）形状原样 PUT 回去——模拟前端"未改密钥"的保存路径。
    const { apiKeyHint, ...withoutHint } = got.models[0]
    const putRes2 = await app.request("http://x/admin-api/models", {
      method: "PUT",
      headers,
      body: JSON.stringify({ models: [withoutHint], chain: got.chain }),
    })
    expect(putRes2.status).toBe(200)

    // 直接读库（跳过 maskModelConfig）核实旧 key 被保留，没有被空值覆盖。
    const stored = await getModelConfig()
    expect(stored.models[0]!.apiKey).toBe("sk-secret-real")
  })

  // 重测/拉取回归：已保存自建条目明文 key 不回显，前端只带 id → 服务端按 id 回填库里 key，
  // 而不是用空 key 探活（否则假失败 → persistedChainFor 把仍可用的模型误踢出链）。
  it("POST /test + /list-models：带 id、无 api_key ⇒ 服务端回填库里 key", async () => {
    await clearAgentModel()
    const { headers } = await makeAdminSession("ops", regA)
    const custom = {
      id: "c2",
      provider: "custom",
      model: "qwen-x",
      params: { temperature: 0.7, maxTokens: 8192, topP: 1 },
      enabled: true,
      test: { status: "passed" as const },
      baseUrl: "http://h:8000/v1",
      apiKey: "sk-stored-key",
    }
    await app.request("http://x/admin-api/models", {
      method: "PUT",
      headers,
      body: JSON.stringify({ models: [custom], chain: ["c2"] }),
    })
    const orig = (globalThis as any).fetch
    let testBody: any
    let listBody: any
    ;(globalThis as any).fetch = (async (url: string, init: any) => {
      const body = JSON.parse(init.body)
      if (String(url).endsWith("/models/list-models")) {
        listBody = body
        return new Response(JSON.stringify({ ok: true, models: ["qwen-x"] }), { status: 200 })
      }
      testBody = body
      return new Response(JSON.stringify({ ok: true, latency_ms: 5, tokens: 1 }), { status: 200 })
    }) as unknown as typeof fetch
    try {
      await app.request("http://x/admin-api/models/test", {
        method: "POST",
        headers,
        body: JSON.stringify({ provider: "custom", model: "qwen-x", base_url: "http://h:8000/v1", id: "c2" }),
      })
      await app.request("http://x/admin-api/models/list-models", {
        method: "POST",
        headers,
        body: JSON.stringify({ baseUrl: "http://h:8000/v1", id: "c2" }),
      })
      expect(testBody.api_key).toBe("sk-stored-key")
      expect(listBody.api_key).toBe("sk-stored-key")
    } finally {
      ;(globalThis as any).fetch = orig
    }
  })
})
