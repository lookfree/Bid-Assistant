import { describe, expect, test } from "bun:test"
import { artifactKeys, scopeAvailability } from "../lib/export-scope"

describe("scopeAvailability", () => {
  test("未标组章节归商务册(与后端/预算同口径)", () => {
    expect(scopeAvailability([{ group: "tech" }, {}])).toEqual({ full: true, tech: true, business: true })
  })
  test("全 tech 时商务册置灰", () => {
    expect(scopeAvailability([{ group: "tech" }])).toEqual({ full: true, tech: true, business: false })
  })
  test("空提纲全部置灰", () => {
    expect(scopeAvailability([])).toEqual({ full: false, tech: false, business: false })
  })
})

describe("artifactKeys", () => {
  test("全量键名不变(兼容),分册带后缀", () => {
    expect(artifactKeys("full")).toEqual({ docx: "docx", pdf: "pdf", pdfPages: "pdf_pages" })
    expect(artifactKeys("tech").docx).toBe("docx_tech")
    expect(artifactKeys("business").pdf).toBe("pdf_biz")
  })
})
