import { describe, it, expect } from "bun:test"
import {
  camelToSnakeParams,
  canEnable,
  canAddToChain,
  moveInChain,
  resetTestOnEdit,
  isInChain,
  persistedChainFor,
  chainSummary,
  saveErrorMessage,
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
  it("即时动作用已保存链，不裹挟未确认的链编辑", () => {
    const saved = ["a", "b"]
    expect(persistedChainFor(saved)).toEqual(["a", "b"])
  })
  it("返回新数组，不改入参", () => {
    const saved = ["a", "b"]
    const out = persistedChainFor(saved)
    expect(out).not.toBe(saved)
  })
  it("删除时同步从已保存链剔除该 id（避免悬空引用）", () => {
    expect(persistedChainFor(["a", "b", "c"], "b")).toEqual(["a", "c"])
  })
  it("删除不在链中的 id → 已保存链原样", () => {
    expect(persistedChainFor(["a", "b"], "z")).toEqual(["a", "b"])
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
