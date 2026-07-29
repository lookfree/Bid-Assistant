import { describe, expect, it } from "bun:test"
import { uploadHint, uploadErrorMessage, UPLOAD_MAX_MB, ACCEPT_BID, ACCEPT_TENDER, ACCEPT_PPT } from "@/lib/files"
import { ApiError } from "@/lib/api-client"

// 全系统上传文案的唯一出口：各入口都调 uploadHint，句式与上限值就不会再各自漂移
// （查重页曾写「≤ 100 MB」而服务端 50MB 直接拒）。
describe("uploadHint", () => {
  it("同族扩展名合并，不啰嗦地列成 Word（.docx）、Word（.doc）", () => {
    expect(uploadHint(ACCEPT_BID)).toBe(`支持 PDF、Word · 单文件最大 ${UPLOAD_MAX_MB}MB`)
    expect(uploadHint(ACCEPT_TENDER)).toBe(`支持 PDF、Word、Excel · 单文件最大 ${UPLOAD_MAX_MB}MB`)
    expect(uploadHint(ACCEPT_PPT)).toBe(`支持 PPT · 单文件最大 ${UPLOAD_MAX_MB}MB`)
  })

  it("多选入口追加同一句提示", () => {
    expect(uploadHint(ACCEPT_TENDER, { multiple: true })).toBe(
      `支持 PDF、Word、Excel · 单文件最大 ${UPLOAD_MAX_MB}MB · 可一次选择多个文件`,
    )
  })

  it("认不出的扩展名跳过，不产出「支持 · 单文件…」这种半截文案", () => {
    expect(uploadHint(".zip,.pdf")).toBe(`支持 PDF · 单文件最大 ${UPLOAD_MAX_MB}MB`)
  })
})

describe("uploadErrorMessage", () => {
  it("超限文案带上具体上限（只说「过大」用户不知道该压到多少）", () => {
    const e = new ApiError(400, "file_too_large")
    expect(uploadErrorMessage(e)).toBe(`文件过大：单文件最大 ${UPLOAD_MAX_MB}MB`)
  })
})
