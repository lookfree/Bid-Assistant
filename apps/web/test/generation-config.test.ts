import { describe, it, expect, beforeEach } from "bun:test"
import {
  budgetForSizing,
  parseBudgetYuan,
  saveGenConfig,
  storedTargetFor,
  suggestedTarget,
  TARGET_MIN,
  TARGET_MAX,
} from "../lib/generation-config"
import { suggestedCharsForPages } from "../lib/page-estimate"

// bun test 无 DOM：给 window/localStorage 打最小内存垫片（generation-config 直接用全局，
// 改成注入属于超范围重构，故只在测试侧补齐）。
const mem = new Map<string, string>()
const shim = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
}
;(globalThis as unknown as { window: unknown }).window = globalThis
;(globalThis as unknown as { localStorage: typeof shim }).localStorage = shim

describe("目标字数按项目隔离 storedTargetFor", () => {
  beforeEach(() => localStorage.clear())

  it("同一项目 → 记住上次选的（重试/重开弹层要用）", () => {
    saveGenConfig({ targetChars: 255_000, format: {} }, "proj-A")
    expect(storedTargetFor("proj-A")).toBe(255_000)
  })

  it("换项目/换包件 → 不返回上个项目的值（否则 98万的包会沿用 425万的项目字数）", () => {
    saveGenConfig({ targetChars: 255_000, format: {} }, "proj-A")
    expect(storedTargetFor("proj-B")).toBeUndefined()
  })

  it("无项目 id（未挂项目）→ 不复用任何历史值", () => {
    saveGenConfig({ targetChars: 255_000, format: {} }, "proj-A")
    expect(storedTargetFor(null)).toBeUndefined()
  })

  it("旧版本残留（存过 targetChars 但没有项目归属）→ 不复用，回落推荐值", () => {
    localStorage.setItem("bid.genConfig", JSON.stringify({ targetChars: 255_000 }))
    expect(storedTargetFor("proj-A")).toBeUndefined()
  })

  it("格式偏好是用户级的，换项目也保留（与字数相反）", () => {
    saveGenConfig({ targetChars: 255_000, format: { body_font: "楷体" } }, "proj-A")
    const raw = JSON.parse(localStorage.getItem("bid.genConfig")!)
    expect(raw.format.body_font).toBe("楷体")
  })
})

describe("多包件字数基准 budgetForSizing", () => {
  const pkgs = [
    { id: "p1", budget: "84.6万元" },
    { id: "p2", budget: "98万元" },
    { id: "p3", budget: "96万元" },
  ]
  it("选中某包 → 用该包限价（而非招标总预算＝各包之和）", () => {
    expect(budgetForSizing("279万元", pkgs, "p2")).toEqual({ budget: "98万元", fromPackage: true })
    // 由此推荐字数按 98 万（≈98 页）而非 279 万（≈279 页）算——密度走排版感知校准基线
    expect(suggestedTarget(10, budgetForSizing("279万元", pkgs, "p2").budget)).toBe(suggestedCharsForPages(98))
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
  it("按预算：一万元一页 × 排版感知密度，下限 80 页", () => {
    expect(suggestedTarget(10, "500万")).toBe(suggestedCharsForPages(500))
    expect(suggestedTarget(10, "600万")).toBe(suggestedCharsForPages(600))
    expect(suggestedTarget(10, "40万")).toBe(suggestedCharsForPages(80)) // max(80,40)=80 页（小预算走下限）
    expect(suggestedTarget(10, "100万")).toBe(suggestedCharsForPages(100))
    // 98 页目标落在 5 万字量级(实测密度 515;旧 600 口径给 5.9 万偏高 ~14%)
    expect(suggestedTarget(10, "98万")).toBeLessThan(55_000)
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
