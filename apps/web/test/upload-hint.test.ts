import { describe, expect, it } from "bun:test"
import { uploadHint, uploadErrorMessage, UPLOAD_MAX_MB, ACCEPT_BID, ACCEPT_TENDER, ACCEPT_PPT } from "@/lib/files"
import { ApiError } from "@/lib/api-client"

// 全系统上传文案的唯一出口：各入口都调 uploadHint，句式与上限值就不会再各自漂移
// （查重页曾写「≤ 100 MB」而服务端 50MB 直接拒）。
describe("uploadHint", () => {
  it("同族扩展名合并，不啰嗦地列成 Word（.docx）、Word（.doc）", () => {
    expect(uploadHint(ACCEPT_BID)).toBe(`支持 PDF、Word · 单文件最大 ${UPLOAD_MAX_MB}MB`)
    expect(uploadHint(ACCEPT_TENDER)).toBe(`支持 Word、Excel · 单文件最大 ${UPLOAD_MAX_MB}MB`)   // PDF 2026-08-26 停收
    expect(uploadHint(ACCEPT_PPT)).toBe(`支持 PPT · 单文件最大 ${UPLOAD_MAX_MB}MB`)
  })

  it("多选入口追加同一句提示", () => {
    expect(uploadHint(ACCEPT_TENDER, { multiple: true })).toBe(
      `支持 Word、Excel · 单文件最大 ${UPLOAD_MAX_MB}MB · 可一次选择多个文件`,
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

// 加密封装/内容不符（2026-08-05 生产事故：DLP 密文一路走到读标才失败）：
// 文案必须说清"是什么问题 + 该怎么办"，只说"上传失败"用户会反复重传同一份密文。
describe("uploadErrorMessage 内容校验", () => {
  it("加密封装：点名是加密软件，并给出解密/外发的下一步", () => {
    const m = uploadErrorMessage(new ApiError(400, "encrypted_wrapper"))
    expect(m).toContain("加密")
    expect(m).toMatch(/解密|外发/)
  })

  it("内容与扩展名不符：说清是内容不符，不能落到「上传失败，请重试」", () => {
    const m = uploadErrorMessage(new ApiError(400, "content_mismatch"))
    expect(m).toContain("扩展名")
    expect(m).not.toBe("上传失败，请重试")
  })
})

// 直传阶段的网络失败也归这个出口（upload 页的 XHR 以 message="network" 抛出，不是 ApiError）——
// 该页原先自带一份码表，新错误码落不进去；文案统一后这条也必须还在。
describe("uploadErrorMessage 网络失败", () => {
  it("XHR 网络错误给出网络提示，而不是笼统的上传失败", () => {
    expect(uploadErrorMessage(new Error("network"))).toContain("网络")
  })

  it("认不出的异常回落调用方给的兜底文案", () => {
    expect(uploadErrorMessage(new Error("boom"), "上传失败，请点击重试")).toBe("上传失败，请点击重试")
  })
})

// .doc 停收（2026-08-15 用户拍板：LibreOffice 转换静默丢图，另存 .docx 是唯一保真路）
import { checkFiles, DOC_UNSUPPORTED_MSG, legacyDocAdvice } from "@/lib/files"

describe("doc 停收", () => {
  it("两个 accept 列表都不再含 .doc；Word/Excel 照常", () => {
    expect(ACCEPT_BID.includes(".doc,") || ACCEPT_BID.endsWith(".doc")).toBe(false)
    expect(ACCEPT_TENDER.includes(".doc,") || ACCEPT_TENDER.endsWith(".doc")).toBe(false)
    // 招标文件侧的 .pdf 另于 2026-08-26 停收（见 tender-accept.test.ts）；标书侧仍收
    expect(ACCEPT_TENDER).toContain(".docx")
    expect(ACCEPT_TENDER).toContain(".xlsx")
  })

  it("选中 .doc 的拒收文案带另存指引，不是干巴巴的「格式不支持」", () => {
    const msg = checkFiles([new File(["x"], "老标书.doc")], ACCEPT_TENDER)
    expect(msg).toContain("老标书.doc")
    expect(msg).toContain("另存为 .docx")
  })

  it("说明横幅同步升级为停收口径", () => {
    expect(legacyDocAdvice(["a.doc"])).toContain(DOC_UNSUPPORTED_MSG)
  })
})
