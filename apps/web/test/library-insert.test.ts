import { describe, expect, it } from "bun:test"
import { libraryItemHtml, isImageAttachment } from "@/app/(tool)/content/use-editor-insert"
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

describe("isImageAttachment", () => {
  it.each(["图片1.png", "扫描件.JPG", "a.jpeg"])("%s 认作图片", (name) => {
    expect(isImageAttachment({ fileId: "f", name })).toBe(true)
  })
  it.each(["合同.pdf", "清单.xlsx", "无扩展名"])("%s 不是图片", (name) => {
    expect(isImageAttachment({ fileId: "f", name })).toBe(false)
  })
})

// 2026-08-06 用户反馈：从资料库插入证照，正文里只出现「附件：图片1.png」一行字，图片本身没进去。
// 用户以为材料已放进标书，审查却报缺件——因为标书里确实只有文件名。
describe("libraryItemHtml 嵌入图片附件", () => {
  it("拿到图片数据就内嵌 <img>，alt 用附件名（审查靠它判断材料在不在）", () => {
    const html = libraryItemHtml(
      item({ attachments: [{ fileId: "f1", name: "营业执照.png" }] }),
      new Map([["f1", "data:image/jpeg;base64,AAA"]]),
    )
    expect(html).toContain('<img src="data:image/jpeg;base64,AAA"')
    expect(html).toContain('alt="营业执照.png"')
  })

  it("图片已内嵌就不再重复列进「附件：」文字", () => {
    const html = libraryItemHtml(
      item({ attachments: [{ fileId: "f1", name: "营业执照.png" }] }),
      new Map([["f1", "data:image/jpeg;base64,AAA"]]),
    )
    expect(html).not.toContain("附件：营业执照.png")
  })

  it("非图片附件仍按文件名列出——它们没法内嵌", () => {
    const html = libraryItemHtml(item({ attachments: [{ fileId: "f2", name: "合同.pdf" }] }), new Map())
    expect(html).toContain("附件：合同.pdf")
  })

  it("取图失败时退回文件名，不是整条插不进去", () => {
    const html = libraryItemHtml(item({ attachments: [{ fileId: "f1", name: "营业执照.png" }] }), new Map())
    expect(html).toContain("附件：营业执照.png")
    expect(html).not.toContain("<img")
  })

  it("有正文的条目照旧逐行成段，并把图片附件附在后面", () => {
    const html = libraryItemHtml(
      item({ body: "第一行\n第二行", attachments: [{ fileId: "f1", name: "章.png" }] }),
      new Map([["f1", "data:image/jpeg;base64,BBB"]]),
    )
    expect(html).toContain("<p>第一行</p>")
    expect(html).toContain("<p>第二行</p>")
    expect(html).toContain("<img")
  })

  it("附件名里的特殊字符要转义，别把 alt 属性截断", () => {
    const html = libraryItemHtml(
      item({ attachments: [{ fileId: "f1", name: 'a"b<c.png' }] }),
      new Map([["f1", "data:image/jpeg;base64,AAA"]]),
    )
    expect(html).not.toContain('alt="a"b')
    expect(html).toContain("&quot;")
  })
})
