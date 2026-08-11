import { describe, it, expect } from "bun:test"
import { fileSummary, fileTitle, kindLabel } from "@/lib/project-files"
import type { ProjectListItem } from "@/lib/project"

const base: ProjectListItem = {
  id: "p1",
  name: "云上江西零信任招标书.doc",
  status: "done",
  currentStep: "done",
  stepIndex: 6,
  totalSteps: 6,
  createdAt: "2026-08-11T06:27:00Z",
}

describe("项目文件构成文案", () => {
  it("生成项目：报招标份数 + 投标是系统生成的", () => {
    const p = { ...base, kind: "bid" as const, tenderFiles: ["公告.pdf", "补遗1号.pdf"], bidFiles: [], hasBid: true }
    expect(fileSummary(p)).toBe("生成项目 · 招标 2 份 · 投标已生成")
  })

  it("生成项目正文还没跑：不能说「已生成」——用户会以为有标书可审查", () => {
    const p = { ...base, kind: "bid" as const, currentStep: "outline" as const, tenderFiles: ["公告.pdf"], hasBid: false }
    expect(fileSummary(p)).toBe("生成项目 · 招标 1 份 · 投标待生成")
  })

  it("线下审查项目：招标与投标都报份数（分册出卷常有多份）", () => {
    const p = {
      ...base,
      kind: "review" as const,
      tenderFiles: ["招标文件.pdf"],
      bidFiles: ["商务标.docx", "技术标.docx", "报价册.docx"],
      hasBid: true,
    }
    expect(fileSummary(p)).toBe("线下审查 · 招标 1 份 · 投标 3 份")
  })

  it("两类项目的标签必须能区分——这正是用户分不清「选的是招标还是投标」的根源", () => {
    expect(kindLabel({ ...base, kind: "bid" })).toBe("生成项目")
    expect(kindLabel({ ...base, kind: "review" })).toBe("线下审查")
  })

  it("老接口没回文件名时回落 tenderCount，不显示成「无招标文件」", () => {
    const p = { ...base, kind: "bid" as const, tenderCount: 3, hasBid: true }
    expect(fileSummary(p)).toBe("生成项目 · 招标 3 份 · 投标已生成")
  })

  it("悬停给出逐份文件名：只报数字的话，传漏补遗照样看不出来", () => {
    const t = fileTitle({ ...base, kind: "review", tenderFiles: ["招标文件.pdf"], bidFiles: ["商务标.docx", "技术标.docx"] })
    expect(t).toContain("· 招标文件.pdf")
    expect(t).toContain("· 商务标.docx")
    expect(t).toContain("· 技术标.docx")
  })

  it("一个文件名都没有时不给空 tooltip", () => {
    expect(fileTitle({ ...base, kind: "bid", tenderCount: 2 })).toBeUndefined()
  })
})
