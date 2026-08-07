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

// 2026-08-07 线上实例：资料条目标题是「营业职照」，附件却叫 flink-logo.png，且是张 logo、
// OCR 识别不出字。审查模型于是只看到「［图片：flink-logo.png］」——用户明明起了名字。
describe("imageAlt 带资料标题", () => {
  it("标题在最前：识别文字被 200 字上限截掉时，这条最有用的信息仍在", () => {
    const alt = imageAlt("flink-logo.png", "字".repeat(500), "营业执照")
    expect(alt.startsWith("营业执照")).toBe(true)
    expect(alt.length).toBeLessThanOrEqual(200)
  })

  it("识别不出文字也要把标题给模型——这正是 logo/图章类图片的常态", () => {
    expect(imageAlt("flink-logo.png", "", "营业职照")).toBe("营业职照｜flink-logo.png")
  })

  it("三者齐全时依次拼接", () => {
    expect(imageAlt("lic.png", "统一社会信用代码 913100", "营业执照")).toBe(
      "营业执照｜lic.png｜统一社会信用代码 913100",
    )
  })

  it("标题与文件名实为同一个名字时不重复占额度", () => {
    expect(imageAlt("营业执照.png", "", "营业执照")).toBe("营业执照")
  })

  it("不传标题时行为与从前一致（其它调用方不受影响）", () => {
    expect(imageAlt("a.png", "x")).toBe("a.png｜x")
  })
})
