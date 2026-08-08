// apps/web/test/pdf-pages-errors.test.ts
// 显式动作不静默:每个错误码都有短提示(spec 2026-08-08 边界表的文案原文)。
import { describe, expect, test } from "bun:test"
import { pdfPagesErrorMessage } from "../lib/files"

// 按 lib/api.ts 的真实错误对象形状构造(动手前先读它,别猜字段名)
const err = (code: string) => Object.assign(new Error(code), { code })

describe("pdfPagesErrorMessage", () => {
  test("逐码映射 spec 文案", () => {
    expect(pdfPagesErrorMessage(err("too_many_pages"))).toBe("页数超过 5 页,暂不支持转换")
    expect(pdfPagesErrorMessage(err("unrenderable"))).toBe("该 PDF 已加密或无法解析")
    expect(pdfPagesErrorMessage(err("agent_unavailable"))).toBe("转换服务暂不可用,稍后再试")
    expect(pdfPagesErrorMessage(err("too_large"))).toBe("文件过大,暂不支持转换")
  })
  test("未知错误给通用兜底", () => {
    expect(pdfPagesErrorMessage(new Error("boom"))).toBe("转换失败,请稍后再试")
  })
})
