import { describe, it, expect } from "bun:test"
import { holdAmountFor, parseContentTiers, settleAmountFor } from "../../src/services/content-pricing"

const TIERS = parseContentTiers([
  { maxChars: 50_000, cost: 40 },
  { maxChars: 150_000, cost: 80 },
  { maxChars: null, cost: 260 },
])

describe("content 结算口径 settleAmountFor", () => {
  it("按总字数落档后多退", () => {
    const held = holdAmountFor(TIERS) // 260
    expect(settleAmountFor(TIERS, 30_000, held)).toBe(40)
    expect(settleAmountFor(TIERS, 120_000, held)).toBe(80)
    expect(settleAmountFor(TIERS, 400_000, held)).toBe(260)
  })

  it("落档价高于预扣额时钳到预扣额（绝不少补扣穿）", () => {
    // 发版兼容场景：在途 run 是按旧 content_long=80 预扣的，而新顶档是 260
    expect(settleAmountFor(TIERS, 400_000, 80)).toBe(80)
    expect(settleAmountFor(TIERS, 120_000, 80)).toBe(80)
    expect(settleAmountFor(TIERS, 30_000, 80)).toBe(40) // 落档价低于预扣额时正常多退
  })

  it("预扣额为 0（异常兜底）时结算也为 0，不会变成负数补扣", () => {
    expect(settleAmountFor(TIERS, 400_000, 0)).toBe(0)
  })
})
