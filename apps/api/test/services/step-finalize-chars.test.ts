import { describe, it, expect } from "bun:test"
import { totalChapterChars } from "../../src/services/step-finalize"

describe("totalChapterChars（本次产出正文总字数）", () => {
  it("多章求和，而不是取最长一章", () => {
    const result = { c1: "<p>" + "甲".repeat(1000) + "</p>", c2: "<p>" + "乙".repeat(1500) + "</p>" }
    expect(totalChapterChars(result)).toBe(2500)
  })

  it("剥掉 HTML 标签后再计数", () => {
    expect(totalChapterChars({ c1: '<h3 class="x">标题</h3><p>正文</p>' })).toBe(4)
  })

  it("非字符串值忽略；空/非对象返回 0", () => {
    expect(totalChapterChars({ c1: "四个字符", c2: null, c3: 42, c4: { a: 1 } })).toBe(4)
    expect(totalChapterChars(null)).toBe(0)
    expect(totalChapterChars("字符串")).toBe(0)
    expect(totalChapterChars({})).toBe(0)
  })
})
