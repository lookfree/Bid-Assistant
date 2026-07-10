import { describe, it, expect, afterAll, setDefaultTimeout } from "bun:test"
import { Hono } from "hono"
import { adminRoutes } from "../src/routes/admin"
import { getDb, closeDb } from "../src/db/client"
import { adminUsers, billingConfigs } from "../src/db/schema"
import { eq } from "drizzle-orm"
import { makeAdminSession, TEST_TIMEOUT_MS } from "./repos/helpers"

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
})
