import { describe, expect, it } from "bun:test"
import { deriveRisk, deriveHealthReport } from "@/lib/risk-derive"
import type { RiskReport } from "@/lib/bid-types"

// 2026-08-01 产品口径：整改建议对所有用户免费下发，原 adviceLocked 裁剪与透传已移除。
const base: RiskReport = {
  score: 45, high: 1, mid: 0, passed: 2,
  items: [{ level: "高", tone: "destructive", title: "缺认证", advice: "", tenderRef: "第三章", chapterTitle: "资质", targetTab: "business", targetId: "b2" }],
  passedItems: ["格式合规"],
}

describe("risk-derive advice 透传", () => {
  it("整改建议原样进入两个派生视图（对所有用户免费，无任何裁剪标志）", () => {
    const withAdvice = { ...base, items: [{ ...base.items[0]!, advice: "补 ISO27001 证书" }] }
    expect(deriveRisk(withAdvice).riskItems[0]!.advice).toBe("补 ISO27001 证书")
    expect(deriveHealthReport(withAdvice).items[0]!.advice).toBe("补 ISO27001 证书")
    expect("adviceLocked" in deriveRisk(withAdvice)).toBe(false)
  })
})
