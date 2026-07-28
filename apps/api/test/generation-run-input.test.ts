import { describe, expect, it } from "bun:test"
import { parseGenerationRunInput } from "../src/services/generation-config"

// 纯解析测试（无需真库）：超写校准系数经 billing_configs generation.* 下发（评审修正:
// 持续调优的运营参数不该固化在 agent 代码里,每调一次发一次版会打断在途长任务）。
describe("parseGenerationRunInput", () => {
  it("合法系数下发;未配置/非法/越界一律不带键（agent 用自身默认）", () => {
    expect(parseGenerationRunInput({ "generation.overshoot_calibration": 1.6 })).toEqual({
      overshoot_calibration: 1.6,
    })
    expect(parseGenerationRunInput({ "generation.overshoot_calibration": 1 })).toEqual({
      overshoot_calibration: 1,
    })
    expect(parseGenerationRunInput({})).toEqual({})
    expect(parseGenerationRunInput({ "generation.overshoot_calibration": "坏值" })).toEqual({})
    expect(parseGenerationRunInput({ "generation.overshoot_calibration": 0.5 })).toEqual({}) // <1 会放大目标
    expect(parseGenerationRunInput({ "generation.overshoot_calibration": 99 })).toEqual({})
  })
})
