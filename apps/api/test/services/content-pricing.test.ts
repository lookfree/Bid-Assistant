import { describe, it, expect } from "bun:test"
import {
  costForChars,
  holdAmountFor,
  parseContentTiers,
  settleAmountFor,
  type ContentTier,
} from "../../src/services/content-pricing"

const OK = [
  { maxChars: 50_000, cost: 40 },
  { maxChars: 150_000, cost: 80 },
  { maxChars: 300_000, cost: 150 },
  { maxChars: null, cost: 260 },
]

describe("parseContentTiers 校验（钱的输入，坏值必须拒跑）", () => {
  it("合法阶梯：升序返回且顶档在末位", () => {
    const t = parseContentTiers([{ maxChars: null, cost: 260 }, { maxChars: 150_000, cost: 80 }, { maxChars: 50_000, cost: 40 }])
    expect(t.map((x) => x.maxChars)).toEqual([50_000, 150_000, null])
    expect(t.map((x) => x.cost)).toEqual([40, 80, 260])
  })

  it("非数组 / 空数组 → 抛错", () => {
    expect(() => parseContentTiers(null)).toThrow()
    expect(() => parseContentTiers({})).toThrow()
    expect(() => parseContentTiers([])).toThrow()
  })

  it("cost 非法（负数 / 小数 / 缺失）→ 抛错", () => {
    expect(() => parseContentTiers([{ maxChars: null, cost: -1 }])).toThrow()
    expect(() => parseContentTiers([{ maxChars: null, cost: 1.5 }])).toThrow()
    expect(() => parseContentTiers([{ maxChars: null }])).toThrow()
  })

  it("maxChars 非法（0 / 负数 / 小数 / 字符串）→ 抛错", () => {
    expect(() => parseContentTiers([{ maxChars: 0, cost: 40 }, { maxChars: null, cost: 80 }])).toThrow()
    expect(() => parseContentTiers([{ maxChars: -5, cost: 40 }, { maxChars: null, cost: 80 }])).toThrow()
    expect(() => parseContentTiers([{ maxChars: 1.5, cost: 40 }, { maxChars: null, cost: 80 }])).toThrow()
    expect(() => parseContentTiers([{ maxChars: "5万", cost: 40 }, { maxChars: null, cost: 80 }])).toThrow()
  })

  it("没有顶档 / 多个顶档 → 抛错", () => {
    expect(() => parseContentTiers([{ maxChars: 50_000, cost: 40 }])).toThrow()
    expect(() => parseContentTiers([{ maxChars: null, cost: 40 }, { maxChars: null, cost: 80 }])).toThrow()
  })

  it("字数上限重复 → 抛错", () => {
    expect(() =>
      parseContentTiers([{ maxChars: 50_000, cost: 40 }, { maxChars: 50_000, cost: 80 }, { maxChars: null, cost: 90 }]),
    ).toThrow()
  })

  it("cost=0 是运营的显式决定，允许", () => {
    expect(() => parseContentTiers([{ maxChars: 50_000, cost: 0 }, { maxChars: null, cost: 80 }])).not.toThrow()
  })
})

describe("costForChars 落档（边界：等于阈值落较低档）", () => {
  const tiers: ContentTier[] = parseContentTiers(OK)
  it("各档命中", () => {
    expect(costForChars(tiers, 0)).toBe(40)
    expect(costForChars(tiers, 49_999)).toBe(40)
    expect(costForChars(tiers, 50_000)).toBe(40) // 恰好等于上限 → 落该（低）档
    expect(costForChars(tiers, 50_001)).toBe(80)
    expect(costForChars(tiers, 150_000)).toBe(80)
    expect(costForChars(tiers, 300_000)).toBe(150)
    expect(costForChars(tiers, 300_001)).toBe(260) // 超顶 → 顶档
    expect(costForChars(tiers, 10_000_000)).toBe(260)
  })
})

describe("holdAmountFor 预扣额", () => {
  it("取各档最大价（正常阶梯即顶档价）", () => {
    expect(holdAmountFor(parseContentTiers(OK))).toBe(260)
  })
  it("运营误配（中间档最贵）时仍取最大值，防结算少补扣穿", () => {
    const weird = parseContentTiers([{ maxChars: 50_000, cost: 400 }, { maxChars: null, cost: 100 }])
    expect(holdAmountFor(weird)).toBe(400)
  })
})

describe("settleAmountFor 结算额（落档价钳到预扣额）", () => {
  const tiers = parseContentTiers(OK)
  it("落档价低于预扣额 → 按落档价（多退）", () => {
    expect(settleAmountFor(tiers, 30_000, 260)).toBe(40)
  })
  it("落档价高于预扣额 → 钳到预扣额（绝不少补扣穿）", () => {
    expect(settleAmountFor(tiers, 400_000, 80)).toBe(80)
  })
})
