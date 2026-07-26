import { describe, it, expect } from "bun:test"
import { tiersCostText, fmtTierChars, type ContentTier } from "../lib/content-tiers"

const TIERS: ContentTier[] = [
  { maxChars: 50_000, cost: 40 },
  { maxChars: 150_000, cost: 80 },
  { maxChars: 300_000, cost: 150 },
  { maxChars: null, cost: 260 },
]

describe("fmtTierChars", () => {
  it("万位取整/一位小数；不足一万按字", () => {
    expect(fmtTierChars(50_000)).toBe("5万")
    expect(fmtTierChars(150_000)).toBe("15万")
    expect(fmtTierChars(12_000)).toBe("1.2万")
    expect(fmtTierChars(8_000)).toBe("8000")
  })
  it("小数位向下取整：绝不把阈值说得比实际覆盖范围大", () => {
    expect(fmtTierChars(50_500)).toBe("5万") // 不是 5.1万——50900 字其实已落下一档
    expect(fmtTierChars(12_999)).toBe("1.2万")
    expect(fmtTierChars(129_999)).toBe("12.9万")
  })
})

describe("tiersCostText", () => {
  it("阶梯渲染为一句计费说明，顶档用「更多」", () => {
    expect(tiersCostText(TIERS)).toBe(
      "≤5万字 40 积分 · ≤15万字 80 积分 · ≤30万字 150 积分 · 更多 260 积分,按实际产出总字数分档结算",
    )
  })
  it("单顶档（未分档）也能渲染", () => {
    expect(tiersCostText([{ maxChars: null, cost: 99 }])).toBe("99 积分/次,按实际产出总字数分档结算")
  })
  it("空阶梯 → 明示未配置，绝不编造价格", () => {
    expect(tiersCostText([])).toBe("计费阶梯未配置,请联系运营")
  })
})
