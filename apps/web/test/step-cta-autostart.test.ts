import { describe, expect, it } from "bun:test"

import { costForChars, tiersCostText, type ContentTier } from "../lib/content-tiers"

/* 「少让用户点一步」（2026-08-17 用户口径）：读标/提纲页的下一步按钮直接授权并自动开跑，
   费用写在按钮上。这里钉的是**按钮上那个数字**的正确性——展示价与实扣价不符是计费红线，
   而这个数字现在出现在一个「点了就扣钱」的按钮上，比出现在说明文字里更不能错。 */

const TIERS: ContentTier[] = [
  { maxChars: 20_000, cost: 60 },
  { maxChars: 50_000, cost: 120 },
  { maxChars: null, cost: 200 },
]

describe("按钮上的正文积分", () => {
  it("按目标字数落档（与后端 costForChars 同构）", () => {
    expect(costForChars(TIERS, 15_000)).toBe(60)
    expect(costForChars(TIERS, 20_000)).toBe(60) // 边界含等于
    expect(costForChars(TIERS, 20_001)).toBe(120)
    expect(costForChars(TIERS, 41_200)).toBe(120)
    expect(costForChars(TIERS, 900_000)).toBe(200) // 顶档无上限
  })

  it("阶梯乱序也要落对档——运营后台的顺序不该决定价格", () => {
    const shuffled = [TIERS[2]!, TIERS[0]!, TIERS[1]!]
    expect(costForChars(shuffled, 15_000)).toBe(60)
    expect(costForChars(shuffled, 41_200)).toBe(120)
  })

  it("阶梯未配置 → null，**绝不编一个价格**：按钮退回不带数字的文案", () => {
    expect(costForChars([], 30_000)).toBeNull()
    expect(tiersCostText([])).toContain("未配置")
  })

  it("没有顶档且字数超出所有档 → null，同样不许编价", () => {
    expect(costForChars([{ maxChars: 10_000, cost: 30 }], 99_999)).toBeNull()
  })
})
