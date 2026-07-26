import { describe, it, expect } from "bun:test"
import { budgetForSizing, parseBudgetYuan, suggestedTarget, TARGET_MIN, TARGET_MAX } from "../lib/generation-config"

describe("多包件字数基准 budgetForSizing", () => {
  const pkgs = [
    { id: "p1", budget: "84.6万元" },
    { id: "p2", budget: "98万元" },
    { id: "p3", budget: "96万元" },
  ]
  it("选中某包 → 用该包限价（而非招标总预算＝各包之和）", () => {
    expect(budgetForSizing("279万元", pkgs, "p2")).toEqual({ budget: "98万元", fromPackage: true })
    // 由此推荐字数按 98 万（≈98 页）而非 279 万（≈279 页）算
    expect(suggestedTarget(10, budgetForSizing("279万元", pkgs, "p2").budget)).toBe(98 * 600)
  })

  it("多包件下选中包限价不可解析（面议/空）→ 不用总预算(各包之和,必虚高),回落章数推荐", () => {
    const vague = [{ id: "p1", budget: "面议" }, { id: "p2", budget: "98万元" }]
    expect(budgetForSizing("279万元", vague, "p1")).toEqual({ budget: null, fromPackage: false })
    expect(budgetForSizing("279万元", [{ id: "p1", budget: "" }, ...vague.slice(1)], "p1"))
      .toEqual({ budget: null, fromPackage: false })
    // 回落后按章数推荐（20 章 × 3000），而不是 279 万 → 279 页
    expect(suggestedTarget(20, budgetForSizing("279万元", vague, "p1").budget)).toBe(60_000)
  })

  it("选中包 id 不在包列表（陈旧）→ 回落招标总预算", () => {
    expect(budgetForSizing("279万元", pkgs, "pX")).toEqual({ budget: "279万元", fromPackage: false })
  })

  it("未选包 / 无 packages（单包）→ 回落招标总预算", () => {
    expect(budgetForSizing("279万元", pkgs, null)).toEqual({ budget: "279万元", fromPackage: false })
    expect(budgetForSizing("120万元", undefined, "p2")).toEqual({ budget: "120万元", fromPackage: false })
    expect(budgetForSizing("120万元", [], "p2")).toEqual({ budget: "120万元", fromPackage: false })
  })

  it("单条 packages（非多包件）选中且限价不可解析 → 仍回落招标总预算", () => {
    expect(budgetForSizing("120万元", [{ id: "p1", budget: "面议" }], "p1"))
      .toEqual({ budget: "120万元", fromPackage: false })
  })

  it("fromPackage 与 budget 同源：为真当且仅当返回的就是该包限价", () => {
    for (const [tender, ps, sel] of [
      ["279万元", pkgs, "p2"], ["279万元", pkgs, "pX"], ["279万元", pkgs, null],
      ["279万元", [{ id: "p1", budget: "面议" }, { id: "p2", budget: "1万元" }], "p1"],
    ] as const) {
      const r = budgetForSizing(tender, ps as never, sel)
      const picked = (ps as { id: string; budget: string }[] | null)?.find((p) => p.id === sel)
      expect(r.fromPackage).toBe(r.budget === picked?.budget && r.budget !== tender)
    }
  })
})

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
