import { describe, expect, test } from "bun:test"
import { legacyDocAdvice } from "../lib/files"

// 2026-08-14 实测：LibreOffice 导入 .doc 会静默丢图（授权书四张证件图转丢一张，
// docx/odt/pdf 三条出口全少同一张＝导入滤镜缺陷，升级无效）。服务端已有原始字节
// 对账的丢图兜底，但用户用 Word/WPS 另存 .docx 是保真度天花板——源头提示更稳。
// 提示只对 .doc 出现，且**绝不拦截**（返回文案不是错误）。
describe("legacyDocAdvice", () => {
  test(".doc 触发建议，大小写不敏感", () => {
    expect(legacyDocAdvice(["响应文件.doc"])).toContain("另存为 .docx")
    expect(legacyDocAdvice(["招标文件.DOC"])).toContain("另存为 .docx")
  })

  test(".docx/.pdf/空列表不触发（.docx 不能被 .doc 后缀误伤）", () => {
    expect(legacyDocAdvice(["标书.docx", "附件.pdf"])).toBeNull()
    expect(legacyDocAdvice([])).toBeNull()
  })

  test("混选时只要有一个 .doc 就提示；空名与未选槽位不炸", () => {
    expect(legacyDocAdvice([null, undefined, "商务标.doc", "技术标.docx"])).toContain(".docx")
  })
})
