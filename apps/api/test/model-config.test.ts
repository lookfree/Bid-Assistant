import { describe, it, expect, afterAll, setDefaultTimeout } from "bun:test"
import {
  normalizeModelConfig,
  validateModelConfig,
  getModelConfig,
  saveModelConfig,
  maskApiKey,
  maskModelConfig,
  mergeModelSecrets,
  InvalidParamsError,
  ChainRequiresTestedError,
  retestChain,
  ChainMemberTestFailedError,
  type ModelConfig,
  type ModelEntry,
} from "../src/services/model-config"
import { deriveRunOverride } from "../src/services/agent-client"
import { getDb, closeDb } from "../src/db/client"
import { billingConfigs } from "../src/db/schema"
import { eq } from "drizzle-orm"
import { TEST_TIMEOUT_MS } from "./repos/helpers"

// billing_configs.value 是 NOT NULL：模拟"未配置"用删行，不能 setConfig(key, undefined/null)。
const clearAgentModel = () => getDb().delete(billingConfigs).where(eq(billingConfigs.key, "agent_model"))

setDefaultTimeout(TEST_TIMEOUT_MS)

// 纯逻辑（不连库）：normalizeModelConfig / validateModelConfig / deriveRunOverride —— 本机可跑
describe("spec319 model-config 纯逻辑", () => {
  it("迁移旧结构：{provider,model:null,fallbacks} → models 2 条 + chain 2 项，全 untested/enabled", () => {
    const cfg = normalizeModelConfig({ provider: "deepseek", model: null, fallbacks: "glm:glm-4-flash" })
    expect(cfg.models).toHaveLength(2)
    expect(cfg.chain).toHaveLength(2)
    expect(cfg.models[0]).toMatchObject({ provider: "deepseek", model: "deepseek-chat", enabled: true, test: { status: "untested" } })
    expect(cfg.models[1]).toMatchObject({ provider: "glm", model: "glm-4-flash", enabled: true, test: { status: "untested" } })
    expect(cfg.chain).toEqual([cfg.models[0]!.id, cfg.models[1]!.id])
  })

  it("新结构原样返回 + 缺 params 项补默认", () => {
    const raw = {
      models: [{ id: "m1", provider: "qwen", model: "qwen-plus", params: { temperature: 0.3 }, enabled: true, test: { status: "passed" } }],
      chain: ["m1"],
    }
    const cfg = normalizeModelConfig(raw)
    expect(cfg.models[0]!.params).toEqual({ temperature: 0.3, maxTokens: 8192, topP: 1.0 })
  })

  it("空/undefined → {models:[],chain:[]}", () => {
    expect(normalizeModelConfig(undefined)).toEqual({ models: [], chain: [] })
    expect(normalizeModelConfig(null)).toEqual({ models: [], chain: [] })
  })

  it("validateModelConfig：chain 引用未测通 model → ChainRequiresTestedError", () => {
    const cfg: ModelConfig = {
      models: [{ id: "m1", provider: "deepseek", model: "deepseek-chat", params: { temperature: 0.7, maxTokens: 8192, topP: 1 }, enabled: true, test: { status: "untested" } }],
      chain: ["m1"],
    }
    expect(() => validateModelConfig(cfg)).toThrow(ChainRequiresTestedError)
  })

  // provider 非白名单且无 baseUrl：不再单独走「未知服务商」判定——非内置一律走自建分支，baseUrl 缺失即报
  // InvalidParamsError（要求 baseUrl，见下方「非内置 provider」用例）。UnknownProviderError 类仍导出/
  // 供 route 层兜底 instanceof，但 validateModelConfig 自身分支已不再抛出它。

  it("validateModelConfig：temperature=5/topP=2/maxTokens=-1 → InvalidParamsError", () => {
    const base = { id: "m1", provider: "deepseek", model: "deepseek-chat", enabled: true, test: { status: "passed" as const } }
    expect(() => validateModelConfig({ models: [{ ...base, params: { temperature: 5, maxTokens: 8192, topP: 1 } }], chain: [] })).toThrow(InvalidParamsError)
    expect(() => validateModelConfig({ models: [{ ...base, params: { temperature: 0.7, maxTokens: 8192, topP: 2 } }], chain: [] })).toThrow(InvalidParamsError)
    expect(() => validateModelConfig({ models: [{ ...base, params: { temperature: 0.7, maxTokens: -1, topP: 1 } }], chain: [] })).toThrow(InvalidParamsError)
  })

  it("validateModelConfig：全合法（chain 引用的 model enabled+passed）→ 不抛", () => {
    const cfg: ModelConfig = {
      models: [{ id: "m1", provider: "deepseek", model: "deepseek-chat", params: { temperature: 0.7, maxTokens: 8192, topP: 1 }, enabled: true, test: { status: "passed" } }],
      chain: ["m1"],
    }
    expect(() => validateModelConfig(cfg)).not.toThrow()
  })

  // —— spec319.1 自建端点：validateModelConfig 自建分支（有 baseUrl 时跳过 provider 白名单）——
  const CUSTOM_BASE: Omit<ModelEntry, "id" | "baseUrl" | "apiKey"> = {
    provider: "custom",
    model: "qwen-x",
    params: { temperature: 0.7, maxTokens: 8192, topP: 1 },
    enabled: true,
    test: { status: "passed" },
  }
  it("validateModelConfig：自建条目 baseUrl 非 http/https → InvalidParamsError（不查 provider 白名单）", () => {
    const cfg: ModelConfig = { models: [{ ...CUSTOM_BASE, id: "c1", baseUrl: "ftp://h/v1", apiKey: "sk-x" }], chain: [] }
    expect(() => validateModelConfig(cfg)).toThrow(InvalidParamsError)
  })
  it("validateModelConfig：自建条目 apiKey 空 → InvalidParamsError", () => {
    const cfg: ModelConfig = { models: [{ ...CUSTOM_BASE, id: "c1", baseUrl: "http://h:8000/v1", apiKey: "" }], chain: [] }
    expect(() => validateModelConfig(cfg)).toThrow(InvalidParamsError)
  })
  it("validateModelConfig：自建条目合法（http baseUrl + 非空 apiKey，provider 为自由标签）→ 不抛", () => {
    const cfg: ModelConfig = { models: [{ ...CUSTOM_BASE, id: "c1", baseUrl: "http://h:8000/v1", apiKey: "sk-x" }], chain: [] }
    expect(() => validateModelConfig(cfg)).not.toThrow()
  })
  it("validateModelConfig：非内置 provider（自由标签）且无 baseUrl → InvalidParamsError（走自建分支，要求 baseUrl）", () => {
    const cfg: ModelConfig = { models: [{ ...CUSTOM_BASE, id: "c1", provider: "openai" }], chain: [] }
    expect(() => validateModelConfig(cfg)).toThrow(InvalidParamsError)
  })

  // —— 内置服务商可选覆盖 baseUrl/apiKey：baseUrl/apiKey 均可留空（回退注册表默认/env），
  // 带了 baseUrl 才校验协议，不强制 apiKey 非空（区别于自建分支）。——
  it("validateModelConfig：内置服务商 + 覆盖 baseUrl/apiKey（http，非空 key）→ 不抛", () => {
    const cfg: ModelConfig = {
      models: [{ id: "m1", provider: "deepseek", model: "deepseek-chat", params: { temperature: 0.7, maxTokens: 8192, topP: 1 }, enabled: true, test: { status: "passed" }, baseUrl: "https://proxy.example.com/v1", apiKey: "sk-override" }],
      chain: [],
    }
    expect(() => validateModelConfig(cfg)).not.toThrow()
  })
  it("validateModelConfig：内置服务商 + 覆盖 baseUrl（无 apiKey）→ 不抛（apiKey 可选，回退服务端 env）", () => {
    const cfg: ModelConfig = {
      models: [{ id: "m1", provider: "qwen", model: "qwen-plus", params: { temperature: 0.7, maxTokens: 8192, topP: 1 }, enabled: true, test: { status: "passed" }, baseUrl: "https://proxy.example.com/v1" }],
      chain: [],
    }
    expect(() => validateModelConfig(cfg)).not.toThrow()
  })
  it("validateModelConfig：内置服务商 baseUrl 非 http/https → InvalidParamsError", () => {
    const cfg: ModelConfig = {
      models: [{ id: "m1", provider: "glm", model: "glm-4-flash", params: { temperature: 0.7, maxTokens: 8192, topP: 1 }, enabled: true, test: { status: "passed" }, baseUrl: "ftp://bad-proxy" }],
      chain: [],
    }
    expect(() => validateModelConfig(cfg)).toThrow(InvalidParamsError)
  })

  it("maskApiKey：长 key 首3+****+尾2；短 key 一律 ****", () => {
    expect(maskApiKey("sk-abcdefgyA")).toBe("sk-****yA")
    expect(maskApiKey("abc")).toBe("****")
  })

  it("maskModelConfig：自建条目 apiKey 不出参、apiKeyHint 打码；注册表条目原样不动", () => {
    const cfg: ModelConfig = {
      models: [
        { id: "c1", provider: "custom", model: "qwen-x", params: { temperature: 0.7, maxTokens: 8192, topP: 1 }, enabled: true, test: { status: "passed" }, baseUrl: "http://h:8000/v1", apiKey: "sk-abcdefgyA" },
        { id: "r1", provider: "deepseek", model: "deepseek-chat", params: { temperature: 0.7, maxTokens: 8192, topP: 1 }, enabled: true, test: { status: "passed" } },
      ],
      chain: [],
    }
    const masked = maskModelConfig(cfg)
    expect(masked.models[0]!.apiKey).toBeUndefined()
    expect(masked.models[0]!.apiKeyHint).toBe("sk-****yA")
    expect(masked.models[1]).toEqual(cfg.models[1])
  })

  it("maskModelConfig：按 apiKey 存在与否打码——无 baseUrl 但意外带 key 的条目也不得明文回显", () => {
    const cfg: ModelConfig = {
      models: [
        { id: "x1", provider: "deepseek", model: "deepseek-chat", params: { temperature: 0.7, maxTokens: 8192, topP: 1 }, enabled: true, test: { status: "passed" }, apiKey: "sk-leakleakyZ" },
      ],
      chain: [],
    }
    const masked = maskModelConfig(cfg)
    expect(masked.models[0]!.apiKey).toBeUndefined()
    expect(JSON.stringify(masked)).not.toContain("sk-leakleakyZ")
  })

  it("mergeModelSecrets：自建条目 apiKey 空/缺省 → 按 id 从 stored 取回旧值；带新值 → 用新值覆盖", () => {
    const stored: ModelConfig = {
      models: [{ id: "c1", provider: "custom", model: "qwen-x", params: { temperature: 0.7, maxTokens: 8192, topP: 1 }, enabled: true, test: { status: "passed" }, baseUrl: "http://h:8000/v1", apiKey: "sk-old" }],
      chain: ["c1"],
    }
    const incomingEmpty: ModelConfig = { models: [{ ...stored.models[0]!, apiKey: "" }], chain: ["c1"] }
    expect(mergeModelSecrets(incomingEmpty, stored).models[0]!.apiKey).toBe("sk-old")

    const incomingNew: ModelConfig = { models: [{ ...stored.models[0]!, apiKey: "sk-new" }], chain: ["c1"] }
    expect(mergeModelSecrets(incomingNew, stored).models[0]!.apiKey).toBe("sk-new")
  })

  it("mergeModelSecrets：新建自建条目（stored 里无该 id）且无 key → apiKey 仍为空，交由 validateModelConfig 拒绝", () => {
    const stored: ModelConfig = { models: [], chain: [] }
    const incoming: ModelConfig = {
      models: [{ id: "c-new", provider: "custom", model: "qwen-x", params: { temperature: 0.7, maxTokens: 8192, topP: 1 }, enabled: true, test: { status: "untested" }, baseUrl: "http://h:8000/v1" }],
      chain: [],
    }
    const merged = mergeModelSecrets(incoming, stored)
    expect(merged.models[0]!.apiKey).toBeUndefined()
    expect(() => validateModelConfig(merged)).toThrow(InvalidParamsError)
  })

  it("mergeModelSecrets：注册表条目（无 baseUrl）不受影响，逐字节透传", () => {
    const stored: ModelConfig = { models: [], chain: [] }
    const incoming: ModelConfig = {
      models: [{ id: "r1", provider: "deepseek", model: "deepseek-chat", params: { temperature: 0.7, maxTokens: 8192, topP: 1 }, enabled: true, test: { status: "untested" } }],
      chain: [],
    }
    expect(mergeModelSecrets(incoming, stored)).toEqual(incoming)
  })

  it("mergeModelSecrets：内置服务商只覆盖 apiKey（无 baseUrl）→ 按 id 从 stored 取回旧 key（不再要求 baseUrl 才合并）", () => {
    const stored: ModelConfig = {
      models: [{ id: "m1", provider: "deepseek", model: "deepseek-chat", params: { temperature: 0.7, maxTokens: 8192, topP: 1 }, enabled: true, test: { status: "passed" }, apiKey: "sk-builtin-old" }],
      chain: ["m1"],
    }
    // 模拟前端 GET→打码→原样 PUT 回去：apiKey 缺省、也没有 baseUrl。
    const incoming: ModelConfig = { models: [{ ...stored.models[0]!, apiKey: undefined }], chain: ["m1"] }
    expect(mergeModelSecrets(incoming, stored).models[0]!.apiKey).toBe("sk-builtin-old")
  })

  it("deriveRunOverride：chain=[deepseek(passed), glm(passed)] → 派生 snake params + fallbacks 串 + 结构化 chain", () => {
    const cfg: ModelConfig = {
      models: [
        { id: "a", provider: "deepseek", model: "deepseek-chat", params: { temperature: 0.5, maxTokens: 4096, topP: 0.9 }, enabled: true, test: { status: "passed" } },
        { id: "b", provider: "glm", model: "glm-4-flash", params: { temperature: 0.7, maxTokens: 8192, topP: 1 }, enabled: true, test: { status: "passed" } },
      ],
      chain: ["a", "b"],
    }
    expect(deriveRunOverride(cfg)).toEqual({
      provider: "deepseek",
      model: "deepseek-chat",
      fallbacks: "glm:glm-4-flash",
      params: { temperature: 0.5, max_tokens: 4096, top_p: 0.9 },
      chain: [
        { provider: "deepseek", model: "deepseek-chat", thinking: false },
        { provider: "glm", model: "glm-4-flash", thinking: false },
      ],
    })
  })

  it("deriveRunOverride：自建端点条目 → chain 携带 base_url/api_key，fallbacks 串跳过自建条目", () => {
    const cfg: ModelConfig = {
      models: [
        { id: "a", provider: "deepseek", model: "deepseek-chat", params: { temperature: 0.5, maxTokens: 4096, topP: 0.9 }, enabled: true, test: { status: "passed" } },
        {
          id: "b",
          provider: "custom",
          model: "qwen-x",
          params: { temperature: 0.7, maxTokens: 8192, topP: 1 },
          enabled: true,
          test: { status: "passed" },
          baseUrl: "http://h:8000/v1",
          apiKey: "sk-secret",
        },
      ],
      chain: ["a", "b"],
    }
    const out = deriveRunOverride(cfg)
    expect(out?.fallbacks).toBe("") // 自建条目被跳过，注册表降级串里没有可写的东西
    expect(out?.chain).toEqual([
      { provider: "deepseek", model: "deepseek-chat", thinking: false },
      { provider: "custom", model: "qwen-x", base_url: "http://h:8000/v1", api_key: "sk-secret", thinking: false },
    ])
  })

  it("deriveRunOverride：chain 空 → undefined", () => {
    expect(deriveRunOverride({ models: [], chain: [] })).toBeUndefined()
  })

  // review 主清单#13：agent gateway.py 一直在消费 params.context_window，但此前 App 从未下发过——
  // 运营配 32K 窗口的模型时预算照全局 131072 算，撞 400。主链走顶层 params（agent 已认的路径），
  // 降级链每跳也各自带自己的 context_window（混合 128K/32K 链不能只共享一个值）。
  it("deriveRunOverride：主/降级模型各自配置 contextWindow → 顶层 params 带主模型的，chain 每跳带各自的", () => {
    const cfg: ModelConfig = {
      models: [
        { id: "a", provider: "deepseek", model: "deepseek-chat", params: { temperature: 0.5, maxTokens: 4096, topP: 0.9, contextWindow: 131072 }, enabled: true, test: { status: "passed" } },
        { id: "b", provider: "glm", model: "glm-4-flash", params: { temperature: 0.7, maxTokens: 4095, topP: 1, contextWindow: 32768 }, enabled: true, test: { status: "passed" } },
      ],
      chain: ["a", "b"],
    }
    const out = deriveRunOverride(cfg)
    expect(out?.params).toMatchObject({ context_window: 131072 })
    expect(out?.chain).toEqual([
      { provider: "deepseek", model: "deepseek-chat", thinking: false, context_window: 131072 },
      { provider: "glm", model: "glm-4-flash", thinking: false, context_window: 32768 },
    ])
  })

  it("deriveRunOverride：contextWindow 未配置 → 顶层 params 与 chain 条目均不带该键（不是 undefined 值，是键缺失）", () => {
    const cfg: ModelConfig = {
      models: [{ id: "a", provider: "deepseek", model: "deepseek-chat", params: { temperature: 0.5, maxTokens: 4096, topP: 0.9 }, enabled: true, test: { status: "passed" } }],
      chain: ["a"],
    }
    const out = deriveRunOverride(cfg)
    expect(out?.params && "context_window" in out.params).toBe(false)
    expect(out?.chain?.[0] && "context_window" in out.chain[0]).toBe(false)
  })

  it("deriveRunOverride：不因 test.status=untested 而拒绝下发（降级铁律：run 永远用已配置的跑）", () => {
    const cfg: ModelConfig = {
      models: [{ id: "a", provider: "deepseek", model: "deepseek-chat", params: { temperature: 0.7, maxTokens: 8192, topP: 1 }, enabled: true, test: { status: "untested" } }],
      chain: ["a"],
    }
    expect(deriveRunOverride(cfg)).toMatchObject({ provider: "deepseek", model: "deepseek-chat" })
  })
})

// DB 相关（getModelConfig/saveModelConfig 经 getConfig/setConfig 连真库）—— 需 mbp：
// ./test-on-mbp.sh test/model-config.test.ts
describe("spec319 model-config 服务（连库，mbp 跑）", () => {
  afterAll(async () => {
    await clearAgentModel()
    await closeDb()
  })

  it("getModelConfig：读空配置 → {models:[],chain:[]}", async () => {
    await clearAgentModel()
    expect(await getModelConfig()).toEqual({ models: [], chain: [] })
  })

  it("saveModelConfig：未测通 chain 保存被拒绝，落库值不变", async () => {
    await clearAgentModel()
    const cfg: ModelConfig = {
      models: [{ id: "m1", provider: "deepseek", model: "deepseek-chat", params: { temperature: 0.7, maxTokens: 8192, topP: 1 }, enabled: true, test: { status: "untested" } }],
      chain: ["m1"],
    }
    await expect(saveModelConfig(cfg)).rejects.toThrow(ChainRequiresTestedError)
    expect(await getModelConfig()).toEqual({ models: [], chain: [] })
  })

  it("saveModelConfig：全合法 → 写入成功，getModelConfig 读回一致", async () => {
    const cfg: ModelConfig = {
      models: [{ id: "m1", provider: "deepseek", model: "deepseek-chat", params: { temperature: 0.7, maxTokens: 8192, topP: 1 }, enabled: true, thinking: false, test: { status: "passed" } }],
      chain: ["m1"],
    }
    await saveModelConfig(cfg)
    expect(await getModelConfig()).toEqual(cfg)
  })

  // review 主清单#13：contextWindow 是新加字段，往返落库/读回必须原样保留（正整数），
  // 不带该字段的旧配置也要继续按"未配置"读回（不会被凭空补出一个值）。
  it("saveModelConfig：带 contextWindow 的模型配置往返一致", async () => {
    await clearAgentModel()
    const cfg: ModelConfig = {
      models: [{ id: "m1", provider: "glm", model: "glm-4-flash", params: { temperature: 0.7, maxTokens: 4095, topP: 1, contextWindow: 32768 }, enabled: true, thinking: false, test: { status: "passed" } }],
      chain: ["m1"],
    }
    await saveModelConfig(cfg)
    expect(await getModelConfig()).toEqual(cfg)
  })

  it("saveModelConfig：contextWindow 非正整数 → InvalidParamsError，不落库", async () => {
    await clearAgentModel()
    const cfg: ModelConfig = {
      models: [{ id: "m1", provider: "glm", model: "glm-4-flash", params: { temperature: 0.7, maxTokens: 4095, topP: 1, contextWindow: -1 }, enabled: true, test: { status: "passed" } }],
      chain: ["m1"],
    }
    await expect(saveModelConfig(cfg)).rejects.toThrow(InvalidParamsError)
    expect(await getModelConfig()).toEqual({ models: [], chain: [] })
  })
})

// retestChain（2026-08-01 生产实测的闸门漏洞）：test.status 是客户端自报的——改 key/换链路时
// 旧 "passed" 原样随保存生效，无效 key（恒 401）照样进链路当主力，首个 run 才炸。
// 保存前对链路成员真实测活是唯一可靠判据。
describe("retestChain：保存前链路成员真实测活", () => {
  const entry = (id: string, over: Partial<ModelEntry> = {}): ModelEntry => ({
    id, provider: "deepseek", model: "deepseek-v4-flash",
    params: { temperature: 0.7, maxTokens: 8192, topP: 1 },
    enabled: true, test: { status: "passed", at: "2026-07-01T00:00:00Z", latencyMs: 999 },
    ...over,
  })

  it("链路成员逐个真实测活并盖新测试章；非链路成员不测", async () => {
    const cfg: ModelConfig = { models: [entry("m1"), entry("m2"), entry("m3", { apiKey: "sk-x" })], chain: ["m1", "m3"] }
    const tested: string[] = []
    await retestChain(cfg, async (o) => {
      tested.push(o.api_key ?? o.provider)
      return { ok: true, latencyMs: 42 }
    })
    expect(tested.sort()).toEqual(["deepseek", "sk-x"])   // m2 不在链路,没被测
    expect(cfg.models[0]!.test).toMatchObject({ status: "passed", latencyMs: 42 })
    expect(cfg.models[0]!.test.at).not.toBe("2026-07-01T00:00:00Z")   // 旧章被新章覆盖
    expect(cfg.models[1]!.test.latencyMs).toBe(999)                    // 非链路成员原样
  })

  it("任一成员测活失败 → ChainMemberTestFailedError 点名条目，保存不会发生", async () => {
    const cfg: ModelConfig = { models: [entry("m1"), entry("m2")], chain: ["m1", "m2"] }
    await expect(
      retestChain(cfg, async (o) =>
        o.provider === "deepseek" && cfg.models[0]!.id === "m1" && o.api_key === undefined
          ? { ok: false, error: "Authentication Fails 401" }
          : { ok: true, latencyMs: 10 },
      ),
    ).rejects.toThrow(ChainMemberTestFailedError)
  })

  it("生产复现：带着旧 passed 的无效 key 上链 → 保存被拒（此前静默放行,首个 run 才 401）", async () => {
    const bad = entry("mds", { apiKey: "sk-invalid-5631" })   // test.status 自报 passed
    const cfg: ModelConfig = { models: [bad], chain: ["mds"] }
    await expect(
      retestChain(cfg, async (o) =>
        o.api_key === "sk-invalid-5631" ? { ok: false, error: "401 invalid key" } : { ok: true },
      ),
    ).rejects.toThrow(/mds.*401/)
  })
})
