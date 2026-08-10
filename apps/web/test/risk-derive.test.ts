import { describe, expect, it } from "bun:test"
import { deriveRisk, deriveHealthReport, scanNotice, scanFileLabel } from "@/lib/risk-derive"
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

// 扫描页提示：审查结果里的 scannedFiles 是「OCR 之后**仍**看不见的页」（pdf）或「内嵌图片」（docx，1a09214 加）。
// 这个事实只有模型知道、用户看不到的话，一份大半是扫描件/内嵌图的标书会被当成一份完整审查过的标书。
describe("risk-derive 扫描页提示", () => {
  const scanned = { name: "投标文件.pdf", pages: 366, imagePages: 139 }
  const docxScanned = { name: "商务标.docx", embeddedImages: 7 }

  it("有看不见的页 → 给出总页数与逐文件明细（横条据此渲染）", () => {
    expect(scanNotice({ ...base, scannedFiles: [scanned, { name: "商务标.pdf", pages: 40, imagePages: 11 }] }))
      .toEqual({ pages: 150, images: 0, files: [scanned, { name: "商务标.pdf", pages: 40, imagePages: 11 }] })
  })

  it("docx 内嵌图片 → 按张数计入 images，不与 pdf 扫描页混算", () => {
    expect(scanNotice({ ...base, scannedFiles: [docxScanned] }))
      .toEqual({ pages: 0, images: 7, files: [docxScanned] })
  })

  it("pdf 扫描页与 docx 内嵌图片并存 → 两类都进明细，合并成一条横幅数据", () => {
    expect(scanNotice({ ...base, scannedFiles: [scanned, docxScanned] }))
      .toEqual({ pages: 139, images: 7, files: [scanned, docxScanned] })
  })

  it("没有这个字段（老报告）或全部识别成功 → 不提示，页面一如既往", () => {
    expect(scanNotice(base)).toBeNull()
    expect(scanNotice({ ...base, scannedFiles: [] })).toBeNull()
    expect(scanNotice({ ...base, scannedFiles: [{ ...scanned, imagePages: 0 }] })).toBeNull()
    expect(scanNotice({ ...base, scannedFiles: [{ ...docxScanned, embeddedImages: 0 }] })).toBeNull()
  })
})

describe("risk-derive scanFileLabel", () => {
  it("pdf 条目：看不见的页数/总页数", () => {
    expect(scanFileLabel({ name: "投标文件.pdf", pages: 366, imagePages: 139 })).toBe("《投标文件.pdf》139/366 页")
  })

  it("docx 条目：内嵌图片张数（没有「页」的口径）", () => {
    expect(scanFileLabel({ name: "商务标.docx", embeddedImages: 7 })).toBe("《商务标.docx》7 张内嵌图片")
  })
})
