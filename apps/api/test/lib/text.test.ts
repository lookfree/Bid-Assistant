import { describe, it, expect } from "bun:test"
import { sliceAtCodePoint } from "../../src/lib/text"

// UTF-16 安全截断（终审 wave2）：credentials.ts 的资料库 body 截断、library-ocr.ts 的 OCR 文本
// 截断都曾用裸 String.prototype.slice，切点落在代理对中间会产出孤立代理——孤代理经 JSON 传给
// agent 服务后，Python 侧编码该字符串时抛 UnicodeEncodeError，拖垮同一请求发出的所有模型调用。

describe("sliceAtCodePoint", () => {
  it("切点落在代理对中间（末位是高位代理）→ 回退一位，不产生孤代理", () => {
    // "字".repeat(499) 占 499 个 code unit，紧跟一个 emoji（2 个 code unit：0xD83D 0xDE00）。
    // 裸 slice(0, 500) 会切出 499 个"字" + 高位代理 0xD83D（孤代理）。
    const s = "字".repeat(499) + "😀" + "字".repeat(10)
    const out = sliceAtCodePoint(s, 500)
    expect(out.length).toBe(499) // 回退一位：整个 emoji 被砍掉，而不是留半个
    expect(out).toBe("字".repeat(499))
    const lastCode = out.charCodeAt(out.length - 1)
    expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false) // 末位不是孤立的高位代理
  })

  it("切点不落在代理对中间 → 行为等同裸 slice", () => {
    const s = "普通中文文本，没有代理对"
    expect(sliceAtCodePoint(s, 5)).toBe(s.slice(0, 5))
  })

  it("n 大于等于字符串长度 → 原样返回", () => {
    const s = "短字符串"
    expect(sliceAtCodePoint(s, 100)).toBe(s)
    expect(sliceAtCodePoint(s, s.length)).toBe(s)
  })

  it("n <= 0 → 空串", () => {
    expect(sliceAtCodePoint("abc", 0)).toBe("")
    expect(sliceAtCodePoint("abc", -1)).toBe("")
  })

  it("完整代理对恰好落在切点之前（不跨界）→ 完整保留，不误伤", () => {
    // "😀" 是索引 0-1（高位代理 0，低位代理 1）；切在 2 正好是代理对之后，不该被回退逻辑误伤。
    const s = "😀" + "字".repeat(10)
    const out = sliceAtCodePoint(s, 2)
    expect(out).toBe("😀")
  })
})
