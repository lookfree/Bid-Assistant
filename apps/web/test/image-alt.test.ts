import { describe, it, expect } from "bun:test"
import { imageAlt } from "@/lib/image-insert"

// 审查侧的 strip_inline_images 会把 <img alt> 透出成「［图片：{alt}］」喂给模型。
// alt 里只有「图片1.png」时，审查照样判断不出这是不是身份证——所以要把 OCR 识别到的
// 文字拼进去（2026-08-06 用户反馈：证照以图片放进正文，审查仍报「缺少该材料」）。
describe("imageAlt", () => {
  it("有识别文字就拼在文件名后面", () => {
    expect(imageAlt("营业执照.png", "统一社会信用代码 913100 有效期长期")).toBe(
      "营业执照.png｜统一社会信用代码 913100 有效期长期",
    )
  })

  it("没识别到文字就只留文件名——不拼一个空的分隔符", () => {
    expect(imageAlt("图片1.png", "")).toBe("图片1.png")
    expect(imageAlt("图片1.png", "   ")).toBe("图片1.png")
  })

  it("识别文字过长要截断：alt 是给模型看的一行提示，不是全文", () => {
    const alt = imageAlt("a.png", "字".repeat(500))
    expect(alt.length).toBeLessThanOrEqual(200)
  })

  it("没有文件名时也能只带识别文字", () => {
    expect(imageAlt("", "居民身份证")).toBe("居民身份证")
  })

  it("两者都空时回落到「插图」，而不是空 alt", () => {
    expect(imageAlt("", "")).toBe("插图")
  })

  it("换行与多余空白压平——alt 是单行属性", () => {
    expect(imageAlt("a.png", "第一行\n  第二行")).toBe("a.png｜第一行 第二行")
  })
})
