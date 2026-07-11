import { describe, it, expect } from "bun:test"
import {
  camelToSnakeParams,
  DEFAULT_MODEL_PARAMS,
  canEnable,
  canAddToChain,
  moveInChain,
  resetTestOnEdit,
  isInChain,
  persistedChainFor,
  chainSummary,
  saveErrorMessage,
  providerLabel,
  modelDisplayName,
  isCustomEntry,
  type ModelEntry,
  type ModelConfig,
} from "../lib/model-config"

function entry(over: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id: "m_1",
    provider: "deepseek",
    model: "deepseek-chat",
    params: { temperature: 0.7, maxTokens: 8192, topP: 1.0 },
    enabled: false,
    test: { status: "untested" },
    ...over,
  }
}

describe("spec319 model-config: camelToSnakeParams", () => {
  it("将 maxTokens/topP 转为 max_tokens/top_p 给 /models/test 用", () => {
    expect(camelToSnakeParams({ temperature: 0.6, maxTokens: 4096, topP: 0.9 })).toEqual({
      temperature: 0.6,
      max_tokens: 4096,
      top_p: 0.9,
    })
  })
})

describe("spec319 model-config: canEnable", () => {
  it("测试通过才能启用", () => {
    expect(canEnable(entry({ test: { status: "passed" } }))).toBe(true)
  })
  it("未测试/测试失败不能启用", () => {
    expect(canEnable(entry({ test: { status: "untested" } }))).toBe(false)
    expect(canEnable(entry({ test: { status: "failed", error: "401" } }))).toBe(false)
  })
})

describe("spec319 model-config: canAddToChain", () => {
  it("已启用且测试通过才能加入运行编排", () => {
    expect(canAddToChain(entry({ enabled: true, test: { status: "passed" } }))).toBe(true)
  })
  it("已启用但未测试 → 不能加入", () => {
    expect(canAddToChain(entry({ enabled: true, test: { status: "untested" } }))).toBe(false)
  })
  it("测试通过但未启用 → 不能加入", () => {
    expect(canAddToChain(entry({ enabled: false, test: { status: "passed" } }))).toBe(false)
  })
})

describe("spec319 model-config: moveInChain", () => {
  const chain = ["a", "b", "c"]
  it("上移中间项", () => {
    expect(moveInChain(chain, "b", "up")).toEqual(["b", "a", "c"])
  })
  it("下移中间项", () => {
    expect(moveInChain(chain, "b", "down")).toEqual(["a", "c", "b"])
  })
  it("首项上移 → 越界不变", () => {
    expect(moveInChain(chain, "a", "up")).toEqual(["a", "b", "c"])
  })
  it("末项下移 → 越界不变", () => {
    expect(moveInChain(chain, "c", "down")).toEqual(["a", "b", "c"])
  })
  it("未知 id → 原样返回", () => {
    expect(moveInChain(chain, "z", "up")).toEqual(["a", "b", "c"])
  })
})

describe("spec319 model-config: resetTestOnEdit", () => {
  it("改参数后测试状态重置为 untested，不保留旧的 at/latencyMs/error", () => {
    const m = entry({ test: { status: "passed", at: "2026-07-09T00:00:00Z", latencyMs: 128 } })
    expect(resetTestOnEdit(m)).toEqual({ ...m, test: { status: "untested" } })
  })
})

describe("spec319 model-config: isInChain", () => {
  it("命中/未命中", () => {
    expect(isInChain(["a", "b"], "b")).toBe(true)
    expect(isInChain(["a", "b"], "z")).toBe(false)
  })
})

describe("spec319 model-config: persistedChainFor", () => {
  const ok = (id: string): ModelEntry => ({
    id, provider: "deepseek", model: "deepseek-chat", params: DEFAULT_MODEL_PARAMS,
    enabled: true, test: { status: "passed" },
  })
  it("全测通链：即时动作原样带上（无操作过滤）", () => {
    const models = [ok("a"), ok("b")]
    expect(persistedChainFor(["a", "b"], models)).toEqual(["a", "b"])
  })
  it("返回新数组，不改入参", () => {
    const saved = ["a", "b"]
    const out = persistedChainFor(saved, [ok("a"), ok("b")])
    expect(out).not.toBe(saved)
  })
  it("删除时同步从链剔除该 id（避免悬空引用）", () => {
    expect(persistedChainFor(["a", "b", "c"], [ok("a"), ok("b"), ok("c")], "b")).toEqual(["a", "c"])
  })
  it("自愈：链里未测通/被停用的成员在即时动作提交时被剔除（迁移遗留不再卡住整页）", () => {
    const untested = { ...ok("b"), test: { status: "untested" as const } }
    const disabled = { ...ok("c"), enabled: false }
    expect(persistedChainFor(["a", "b", "c"], [ok("a"), untested, disabled])).toEqual(["a"])
  })
  it("链引用已不存在的 model → 剔除", () => {
    expect(persistedChainFor(["a", "z"], [ok("a")])).toEqual(["a"])
  })
})

describe("spec319 model-config: chainSummary", () => {
  it("空链 → 引导文案", () => {
    const cfg: ModelConfig = { models: [], chain: [] }
    expect(chainSummary(cfg)).toBe("尚未配置主模型，请先在下方模型库启用并测试一个模型")
  })
  it("仅主模型", () => {
    const cfg: ModelConfig = { models: [entry()], chain: ["m_1"] }
    expect(chainSummary(cfg)).toBe("当前生效：DeepSeek deepseek-chat")
  })
  it("主模型 + 降级链", () => {
    const qwen = entry({ id: "m_2", provider: "qwen", model: "qwen-plus" })
    const glm = entry({ id: "m_3", provider: "glm", model: "glm-4-flash" })
    const cfg: ModelConfig = { models: [entry(), qwen, glm], chain: ["m_1", "m_2", "m_3"] }
    expect(chainSummary(cfg)).toBe(
      "当前生效：DeepSeek deepseek-chat，失败依次降级 通义千问 qwen-plus → 智谱 GLM glm-4-flash",
    )
  })
})

describe("spec319.1 model-config: providerLabel", () => {
  it("已知 provider → 对应中文标签", () => {
    expect(providerLabel("deepseek")).toBe("DeepSeek")
    expect(providerLabel("custom")).toBe("自建 (OpenAI 兼容)")
  })
  it("未知 provider → 兜底「自建」", () => {
    expect(providerLabel("some-unknown-provider")).toBe("自建")
  })
})

describe("spec319.1 model-config: isCustomEntry", () => {
  it("provider 为 custom → 自建", () => {
    expect(isCustomEntry({ provider: "custom", baseUrl: undefined })).toBe(true)
  })
  it("带 baseUrl → 自建（即使 provider 还是别的值）", () => {
    expect(isCustomEntry({ provider: "deepseek", baseUrl: "http://h:8000/v1" })).toBe(true)
  })
  it("注册表条目（无 baseUrl，非 custom）→ 不是自建", () => {
    expect(isCustomEntry({ provider: "qwen", baseUrl: undefined })).toBe(false)
  })
})

describe("spec319.1 model-config: modelDisplayName", () => {
  it("自建条目（带 baseUrl）→ `model @ host`", () => {
    const m = entry({ provider: "custom", model: "qwen2.5-72b", baseUrl: "http://192.168.1.10:8000/v1" })
    expect(modelDisplayName(m)).toBe("qwen2.5-72b @ 192.168.1.10:8000")
  })
  it("注册表条目 → `label model`（与旧展示逐字节一致）", () => {
    expect(modelDisplayName(entry())).toBe("DeepSeek deepseek-chat")
  })
  it("baseUrl 格式异常 → 回退 `label model` 格式", () => {
    const m = entry({ provider: "custom", model: "x", baseUrl: "not-a-url" })
    expect(modelDisplayName(m)).toBe("自建 (OpenAI 兼容) x")
  })
})

describe("spec319 model-config: saveErrorMessage", () => {
  it("已知 error code 给可读提示", () => {
    expect(saveErrorMessage("chain_requires_tested_models")).toBe("降级链里有未测试通过的模型，请先测试")
    expect(saveErrorMessage("invalid_params")).toBe("参数超出范围")
    expect(saveErrorMessage("unknown_provider")).toBe("未知服务商")
  })
  it("未知/缺失 code 给通用失败文案", () => {
    expect(saveErrorMessage(undefined)).toBe("保存失败，请重试")
    expect(saveErrorMessage("weird_code")).toBe("保存失败，请重试")
  })
})
