import { describe, expect, test } from "bun:test"
import { pdfUnavailableFor, type ExportArtifacts } from "@/app/(tool)/content/use-export"

// 终审 I1：pdfUnavailableFor 只在"该 scope 已产出 docx 但 pdf 缺失"（导过、转换失败）时置灰 PDF——
// 从未导出过该 scope（docx 键也不存在）不该置灰，否则分册 PDF 的首次导出会被堵死。
describe("pdfUnavailableFor", () => {
  test("exportedResult 为 null（还没跑过 export 步）：不置灰", () => {
    expect(pdfUnavailableFor(null, "full")).toBe(false)
  })

  test("该 scope 从未导出过（docx 键也不存在）：不置灰——不能因为没导过就堵死首次导出", () => {
    const exported: ExportArtifacts = { docxTech: "artifacts/x/bid_tech.docx", pdfTech: "artifacts/x/bid_tech.pdf" }
    expect(pdfUnavailableFor(exported, "full")).toBe(false) // full 的 docx/pdf 键都不存在
  })

  test("已导出且 PDF 转换成功（docx/pdf 都在）：不置灰", () => {
    const exported: ExportArtifacts = { docx: "artifacts/x/bid.docx", pdf: "artifacts/x/bid.pdf" }
    expect(pdfUnavailableFor(exported, "full")).toBe(false)
  })

  test("已导出但 PDF 转换失败（docx 在、pdf 为 null）：置灰", () => {
    const exported: ExportArtifacts = { docx: "artifacts/x/bid.docx", pdf: undefined }
    expect(pdfUnavailableFor(exported, "full")).toBe(true)
  })

  test("分册键随 scope 走：技术册转换失败不误判商务册（商务册仍有 pdf 键）", () => {
    const exported: ExportArtifacts = {
      docxTech: "artifacts/x/bid_tech.docx", pdfTech: undefined,
      docxBiz: "artifacts/x/bid_biz.docx", pdfBiz: "artifacts/x/bid_biz.pdf",
    }
    expect(pdfUnavailableFor(exported, "tech")).toBe(true)
    expect(pdfUnavailableFor(exported, "business")).toBe(false)
  })
})
