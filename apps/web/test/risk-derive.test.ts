import { describe, expect, it } from "bun:test"
import { deriveRisk, deriveHealthReport } from "@/lib/risk-derive"
import type { RiskReport } from "@/lib/bid-types"

// adviceLocked 透传（评审修正,方案 A）：非会员时 App 出口裁掉 items[].advice 并带 adviceLocked,
// 三个展示面（体检摘要/完整报告/审查页）都以它为唯一渲染依据——此前一锁两不锁自相矛盾。
const base: RiskReport = {
  score: 45, high: 1, mid: 0, passed: 2,
  items: [{ level: "高", tone: "destructive", title: "缺认证", advice: "", tenderRef: "第三章", chapterTitle: "资质", targetTab: "business", targetId: "b2" }],
  passedItems: ["格式合规"],
}

describe("risk-derive adviceLocked 透传", () => {
  it("裁剪结果（adviceLocked:true）→ 两个派生视图都为 true", () => {
    expect(deriveRisk({ ...base, adviceLocked: true }).adviceLocked).toBe(true)
    expect(deriveHealthReport({ ...base, adviceLocked: true }).adviceLocked).toBe(true)
  })
  it("会员结果（无该字段）→ false（绝不误锁）", () => {
    expect(deriveRisk(base).adviceLocked).toBe(false)
    expect(deriveHealthReport(base).adviceLocked).toBe(false)
  })
})
