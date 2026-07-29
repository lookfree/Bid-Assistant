import { describe, expect, it } from "bun:test"
import { libraryItemHtml } from "@/app/(tool)/content/use-editor-insert"
import type { LibraryItem } from "@/lib/library"

const item = (p: Partial<LibraryItem> = {}): LibraryItem =>
  ({ id: "i1", category: "text", title: "公司简介", ...p }) as LibraryItem

describe("libraryItemHtml", () => {
  it("正文逐行成段", () => {
    expect(libraryItemHtml(item({ body: "第一行\n\n第二行" }))).toBe("<p>第一行</p><p>第二行</p>")
  })

  it("无正文时拼标题/字段/附件摘要", () => {
    const html = libraryItemHtml(
      item({ meta: "2026 版", fields: [{ label: "注册资本", value: "1000万" }], attachments: [{ fileId: "f", key: "k", name: "营业执照.pdf" }] }),
    )
    expect(html).toBe("<p><strong>公司简介</strong>，2026 版，注册资本：1000万，附件：营业执照.pdf。</p>")
  })

  it("纯文本必须转义：< 之后的内容曾被浏览器当标签整段吞掉（静默丢内容）", () => {
    expect(libraryItemHtml(item({ body: "响应时间 < 2 小时，7×24 值守" }))).toBe(
      "<p>响应时间 &lt; 2 小时，7×24 值守</p>",
    )
    expect(libraryItemHtml(item({ title: "A&B <科技>" }))).toBe("<p><strong>A&amp;B &lt;科技&gt;</strong>。</p>")
  })
})
