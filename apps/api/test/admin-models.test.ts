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


// PUT 现在会对链路成员真实测活（2026-08-01 闸门修复）：测试里 mock agent 中继。
const withAgentTest = async <T>(reply: { ok: boolean; latency_ms?: number; error?: string }, fn: () => T | Promise<T>): Promise<T> => {
  const orig = (globalThis as any).fetch
  ;(globalThis as any).fetch = (async () => new Response(JSON.stringify(reply), { status: 200 })) as unknown as typeof fetch
  try {
    return await fn()
  } finally {
    ;(globalThis as any).fetch = orig
  }
}

describe("spec319 /admin-api/models", () => {
  it("GET 返回当前配置（空 → {models:[],chain:[]}）", async () => {
    await clearAgentModel()
    const { headers } = await makeAdminSession("ops", regA)
    const res = await app.request("http://x/admin-api/models", { headers })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ models: [], chain: [] })
  })

  it("PUT 链路成员测活失败 → 400 chain_member_test_failed 点名条目，不落库（生产复现：无效 key 带旧 passed 上链）", async () => {
    await clearAgentModel()
    const { headers } = await makeAdminSession("ops", regA)
    const body = {
      models: [{ id: "m1", provider: "deepseek", model: "deepseek-chat", params: { temperature: 0.7, maxTokens: 8192, topP: 1 }, enabled: true, test: { status: "passed" } }],
      chain: ["m1"],
    }
    const res = await withAgentTest({ ok: false, error: "Authentication Fails 401" }, () =>
      app.request("http://x/admin-api/models", { method: "PUT", headers, body: JSON.stringify(body) }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: "chain_member_test_failed", id: "m1" })
    const after = await app.request("http://x/admin-api/models", { headers })
    expect(await after.json()).toEqual({ models: [], chain: [] })
  })

  it("PUT 未测通成员上链但真实测活通过 → 200 且服务端盖新测试章（活测取代自报状态）", async () => {
    await clearAgentModel()
    const { headers } = await makeAdminSession("ops", regA)
    const body = {
      models: [{ id: "m1", provider: "deepseek", model: "deepseek-chat", params: { temperature: 0.7, maxTokens: 8192, topP: 1 }, enabled: true, test: { status: "untested" } }],
      chain: ["m1"],
    }
    const res = await withAgentTest({ ok: true, latency_ms: 66 }, () =>
      app.request("http://x/admin-api/models", { method: "PUT", headers, body: JSON.stringify(body) }))
    expect(res.status).toBe(200)
    const stored = await getModelConfig()
    expect(stored.models[0]!.test).toMatchObject({ status: "passed", latencyMs: 66 })
  })

  // 2026-08-24 生产：链上主模型（自建 vLLM 端点）崩了，运营想加一个官方 DeepSeek 当备用来救火，
  // 结果点「保存参数」一律 400——闸把「这次根本没动过的链上成员」也重测，用坏模型连坐了无关的保存。
  // 闸的本意是防「未经验证的东西**被推上**链」，不是让一个坏成员冻结整份配置的编辑能力。
  const M1 = { id: "m1", provider: "deepseek", model: "deepseek-chat", params: { temperature: 0.7, maxTokens: 8192, topP: 1 }, enabled: true, test: { status: "passed" } }

  async function seedChain(headers: Record<string, string>) {
    await clearAgentModel()
    const res = await withAgentTest({ ok: true, latency_ms: 5 }, () =>
      app.request("http://x/admin-api/models", { method: "PUT", headers, body: JSON.stringify({ models: [M1], chain: ["m1"] }) }))
    expect(res.status).toBe(200)
  }

  it("PUT 链上成员原样未动 → 不重测，其故障不阻塞无关条目的保存", async () => {
    const { headers } = await makeAdminSession("ops", regA)
    await seedChain(headers)
    // 此刻链上的 m1 已经坏了（测活必失败）；本次只想新增一个不上链的库存条目 m2
    const m2 = { id: "m2", provider: "glm", model: "glm-4-flash", params: { temperature: 0.7, maxTokens: 4096, topP: 1 }, enabled: false, test: { status: "untested" } }
    const res = await withAgentTest({ ok: false, error: "EngineCore encountered an issue" }, () =>
      app.request("http://x/admin-api/models", { method: "PUT", headers, body: JSON.stringify({ models: [M1, m2], chain: ["m1"] }) }))
    expect(res.status).toBe(200)
    const stored = await getModelConfig()
    expect(stored.models.map((m) => m.id).sort()).toEqual(["m1", "m2"])
    expect(stored.chain).toEqual(["m1"])          // 链未被本次保存改动
  })

  it("PUT 改了链上成员的模型名 → 仍必须现场测活，坏了照样 400（不给绕过闸的口子）", async () => {
    const { headers } = await makeAdminSession("ops", regA)
    await seedChain(headers)
    const changed = { ...M1, model: "deepseek-v4-pro" }   // 换了模型名 = 换了要调用的东西
    const res = await withAgentTest({ ok: false, error: "model does not exist" }, () =>
      app.request("http://x/admin-api/models", { method: "PUT", headers, body: JSON.stringify({ models: [changed], chain: ["m1"] }) }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: "chain_member_test_failed", id: "m1" })
  })

  it("PUT 跳过重测的成员，test 状态以库里为准（前端塞的 passed 不作数）", async () => {
    const { headers } = await makeAdminSession("ops", regA)
    await seedChain(headers)
    const lying = { ...M1, test: { status: "passed", latencyMs: 999999, at: "2000-01-01T00:00:00.000Z" } }
    const res = await withAgentTest({ ok: false, error: "should not be called" }, () =>
      app.request("http://x/admin-api/models", { method: "PUT", headers, body: JSON.stringify({ models: [lying], chain: ["m1"] }) }))
    expect(res.status).toBe(200)
    const stored = await getModelConfig()
    expect(stored.models[0]!.test.latencyMs).toBe(5)          // 库里那次真测的 5ms，不是客户端编的
    expect(stored.models[0]!.test.at).not.toBe("2000-01-01T00:00:00.000Z")
  })

  it("PUT 全合法 → 200 落库", async () => {
    const { headers } = await makeAdminSession("ops", regA)
    const body = {
      models: [{ id: "m1", provider: "deepseek", model: "deepseek-chat", params: { temperature: 0.7, maxTokens: 8192, topP: 1 }, enabled: true, test: { status: "passed" } }],
      chain: ["m1"],
    }
    const res = await withAgentTest({ ok: true, latency_ms: 5 }, () =>
      app.request("http://x/admin-api/models", { method: "PUT", headers, body: JSON.stringify(body) }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  // review 主清单#13：PUT 的 zod 形状校验（ModelParamsSchema）要接受 contextWindow 并原样落库/回显——
  // 这是运营在后台把 32K 窗口填进模型配置的唯一入口，缺了它字段会在 400 invalid_input 或落库时被吞掉。
  it("PUT 带 contextWindow 的模型配置 → 200 落库，GET 读回原样带着该字段", async () => {
    await clearAgentModel()
    const { headers } = await makeAdminSession("ops", regA)
    const body = {
      models: [{ id: "m1", provider: "glm", model: "glm-4-flash", params: { temperature: 0.7, maxTokens: 4095, topP: 1, contextWindow: 32768 }, enabled: true, test: { status: "passed" } }],
      chain: ["m1"],
    }
    const putRes = await withAgentTest({ ok: true, latency_ms: 5 }, () =>
      app.request("http://x/admin-api/models", { method: "PUT", headers, body: JSON.stringify(body) }))
    expect(putRes.status).toBe(200)
    const getRes = await app.request("http://x/admin-api/models", { headers })
    const got = (await getRes.json()) as any
    expect(got.models[0].params.contextWindow).toBe(32768)
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
    const putRes1 = await withAgentTest({ ok: true, latency_ms: 5 }, () =>
      app.request("http://x/admin-api/models", {
        method: "PUT",
        headers,
        body: JSON.stringify({ models: [custom], chain: ["c1"] }),
      }))
    expect(putRes1.status).toBe(200)

    const getRes = await app.request("http://x/admin-api/models", { headers })
    const got = (await getRes.json()) as any
    expect(got.models[0].apiKey).toBeUndefined()
    expect(JSON.stringify(got)).not.toContain("sk-secret-real")
    expect(got.models[0].apiKeyHint).toBe("sk-****al")

    // 用 GET 回来的（打码、无明文 apiKey）形状原样 PUT 回去——模拟前端"未改密钥"的保存路径。
    const { apiKeyHint, ...withoutHint } = got.models[0]
    const putRes2 = await withAgentTest({ ok: true, latency_ms: 5 }, () =>
      app.request("http://x/admin-api/models", {
      method: "PUT",
      headers,
      body: JSON.stringify({ models: [withoutHint], chain: got.chain }),
    }))
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
    await withAgentTest({ ok: true, latency_ms: 5 }, () =>
      app.request("http://x/admin-api/models", {
        method: "PUT",
        headers,
        body: JSON.stringify({ models: [custom], chain: ["c2"] }),
      }))
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

  // 内置服务商只覆盖 apiKey、不覆盖 base_url（Task 1 新增）：重测时前端带 id、不带 base_url/api_key，
  // 服务端仍需按 id 回填库里的覆盖 key——不能因为没有 base_url 就跳过回填，否则重测会静默退回 env key。
  it("POST /test：内置服务商已保存的 apiKey 覆盖（无 base_url）→ 服务端按 id 回填库里 key", async () => {
    await clearAgentModel()
    const { headers } = await makeAdminSession("ops", regA)
    const builtin = {
      id: "m-builtin",
      provider: "deepseek",
      model: "deepseek-chat",
      params: { temperature: 0.7, maxTokens: 8192, topP: 1 },
      enabled: true,
      test: { status: "passed" as const },
      apiKey: "sk-builtin-override",
    }
    await withAgentTest({ ok: true, latency_ms: 5 }, () =>
      app.request("http://x/admin-api/models", {
        method: "PUT",
        headers,
        body: JSON.stringify({ models: [builtin], chain: ["m-builtin"] }),
      }))
    const orig = (globalThis as any).fetch
    let testBody: any
    ;(globalThis as any).fetch = (async (_url: string, init: any) => {
      testBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ ok: true, latency_ms: 5, tokens: 1 }), { status: 200 })
    }) as unknown as typeof fetch
    try {
      await app.request("http://x/admin-api/models/test", {
        method: "POST",
        headers,
        body: JSON.stringify({ provider: "deepseek", model: "deepseek-chat", id: "m-builtin" }),
      })
      expect(testBody.api_key).toBe("sk-builtin-override")
      expect(testBody.base_url).toBeUndefined()
    } finally {
      ;(globalThis as any).fetch = orig
    }
  })
})
