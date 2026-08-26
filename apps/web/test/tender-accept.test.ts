import { describe, expect, test } from "bun:test"
import { ACCEPT_TENDER, ACCEPT_BID, PDF_UNSUPPORTED_MSG, uploadHint } from "../lib/files"

/* 2026-08-26 用户拍板停收 PDF 招标文件。
   原因是结构性的，不是某个 bug：表单模板的「复印机」复刻的是 docx 的 body XML，
   PDF 根本没有这个东西，只能退到文本路径——页脚页码混进正文只是最显眼的一个症状
   （生产实测：16 页 PDF 的页码全部成了独立条款，「6 / 16」被复刻进投标文件），
   同一条路上还有跨页断行、表格塌成文本行、栏序错乱。

   注意范围：只停收**招标文件**。ACCEPT_BID（查重/风险审查上传的我方标书）不受影响——
   那条链只读文字、不进复印机，PDF 在那里是好用的。 */

describe("招标文件停收 PDF", () => {
  test("ACCEPT_TENDER 不再包含 .pdf，Word/Excel 保留", () => {
    const exts = ACCEPT_TENDER.split(",").map((e) => e.trim())
    expect(exts).not.toContain(".pdf")
    expect(exts).toEqual([".docx", ".xlsx", ".xls"])
  })

  test("上传提示不再宣称支持 PDF（提示与实际受理必须一致）", () => {
    expect(uploadHint(ACCEPT_TENDER)).not.toContain("PDF")
    expect(uploadHint(ACCEPT_TENDER)).toContain("Word")
  })

  test("拒收文案说清为什么、以及该怎么办", () => {
    expect(PDF_UNSUPPORTED_MSG).toContain("PDF")
    expect(PDF_UNSUPPORTED_MSG).toContain(".docx")
  })

  test("标书侧（查重/审查）仍收 PDF —— 那条链不进复印机", () => {
    expect(ACCEPT_BID.split(",").map((e) => e.trim())).toContain(".pdf")
  })
})
