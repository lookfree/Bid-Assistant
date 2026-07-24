import { describe, it, expect } from "bun:test"
import { parseBudgetYuan, suggestedTarget, TARGET_MIN, TARGET_MAX } from "../lib/generation-config"

describe("招标预算解析 parseBudgetYuan", () => {
  it("万/亿单位换算", () => {
    expect(parseBudgetYuan("600万")).toBe(6_000_000)
    expect(parseBudgetYuan("600万元")).toBe(6_000_000)
    expect(parseBudgetYuan("¥600万元人民币")).toBe(6_000_000)
    expect(parseBudgetYuan("1.2亿")).toBe(120_000_000)
  })

  it("无单位大数按元；千分位去除", () => {
    expect(parseBudgetYuan("6,000,000元")).toBe(6_000_000)
    expect(parseBudgetYuan("6000000")).toBe(6_000_000)
  })

  it("不可靠输入 → null（回退章数推荐）", () => {
    expect(parseBudgetYuan("")).toBeNull()
    expect(parseBudgetYuan(null)).toBeNull()
    expect(parseBudgetYuan("详见招标文件")).toBeNull()
    expect(parseBudgetYuan("600")).toBeNull() // 无单位且量级不明
    expect(parseBudgetYuan("0万")).toBeNull()
  })
})

describe("初始字数推荐 suggestedTarget", () => {
  it("按预算：一万元一页 × 600 字/页，下限 80 页", () => {
    expect(suggestedTarget(10, "500万")).toBe(300_000) // 500 页 × 600
    expect(suggestedTarget(10, "600万")).toBe(360_000) // 600 页 × 600
    expect(suggestedTarget(10, "40万")).toBe(48_000) // max(80,40)=80 页 × 600（小预算走下限）
    expect(suggestedTarget(10, "100万")).toBe(60_000) // 100 页 × 600
  })

  it("大预算封顶 50 万字、结果始终夹在 [MIN,MAX]", () => {
    expect(suggestedTarget(10, "1亿")).toBe(TARGET_MAX)
    const t = suggestedTarget(5, "300万")
    expect(t).toBeGreaterThanOrEqual(TARGET_MIN)
    expect(t).toBeLessThanOrEqual(TARGET_MAX)
  })

  it("无预算信号 → 回退章数 × 3000", () => {
    expect(suggestedTarget(20)).toBe(60_000)
    expect(suggestedTarget(20, "详见招标文件")).toBe(60_000)
    expect(suggestedTarget(2)).toBe(TARGET_MIN) // 6000 夹到下限
  })
})
