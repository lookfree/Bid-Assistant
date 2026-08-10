import { describe, expect, it } from "bun:test"
import { deriveRisk, deriveHealthReport, scanNotice } from "@/lib/risk-derive"
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

// 扫描页提示：审查结果里的 scannedFiles 是「OCR 之后**仍**看不见的页」。
// 这个事实只有模型知道、用户看不到的话，一份大半是扫描件的标书会被当成一份完整审查过的标书。
describe("risk-derive 扫描页提示", () => {
  const scanned = { name: "投标文件.pdf", pages: 366, imagePages: 139 }

  it("有看不见的页 → 给出总页数与逐文件明细（横条据此渲染）", () => {
    expect(scanNotice({ ...base, scannedFiles: [scanned, { name: "商务标.pdf", pages: 40, imagePages: 11 }] }))
      .toEqual({ pages: 150, files: [scanned, { name: "商务标.pdf", pages: 40, imagePages: 11 }] })
  })

  it("没有这个字段（老报告）或全部识别成功 → 不提示，页面一如既往", () => {
    expect(scanNotice(base)).toBeNull()
    expect(scanNotice({ ...base, scannedFiles: [] })).toBeNull()
    expect(scanNotice({ ...base, scannedFiles: [{ ...scanned, imagePages: 0 }] })).toBeNull()
  })
})
