// spec 2026-08-08-library-pdf-pages:插入层唯一新规则——已转出页图的 PDF 不再按文件名列出
// (防审查把一份证书数成两份);未转出的 PDF 照旧列出(回归)。
import { describe, expect, test } from "bun:test"
import { hasDerivedPages, libraryItemHtml } from "../app/(tool)/content/use-editor-insert"
import { type LibraryItem } from "../lib/library"

const pdf = { fileId: "f-pdf", name: "检测证书.pdf" }
const page1 = { fileId: "f-p1", name: "检测证书-第1页.png", sourceFileId: "f-pdf" }
const item = (atts: object[]): LibraryItem =>
  ({ id: "i1", title: "检测证书", attachments: atts }) as LibraryItem

describe("已转出页图的 PDF", () => {
  test("hasDerivedPages 按 sourceFileId 配对", () => {
    expect(hasDerivedPages(pdf, [pdf, page1])).toBe(true)
    expect(hasDerivedPages(pdf, [pdf])).toBe(false)
  })

  test("附件行不再列 PDF 文件名,页图正常内嵌", () => {
    const images = new Map([["f-p1", "data:image/jpeg;base64,x"]])
    const html = libraryItemHtml(item([pdf, page1]), images)
    expect(html).toContain('src="data:image/jpeg;base64,x"')
    expect(html).not.toContain("检测证书.pdf")
  })

  test("回归:未转出页图的 PDF 照旧按文件名列出", () => {
    expect(libraryItemHtml(item([pdf]))).toContain("检测证书.pdf")
  })
})
