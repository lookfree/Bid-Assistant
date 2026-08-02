import { describe, it, expect } from "bun:test"
import { formatDateTime } from "../lib/format"

describe("formatDateTime：审计日志时间显示（QA：原样渲染 ISO 串不可读）", () => {
  it("ISO → 本地 YYYY-MM-DD HH:mm:ss", () => {
    const out = formatDateTime("2026-07-23T14:31:46.123Z")
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    // 不依赖测试机时区断言绝对值,但北京时区下应为 22:31:46
    if (new Date().getTimezoneOffset() === -480) expect(out).toBe("2026-07-23 22:31:46")
  })
  it("空/非法 → '-'，绝不渲染 Invalid Date", () => {
    expect(formatDateTime(undefined)).toBe("-")
    expect(formatDateTime(null)).toBe("-")
    expect(formatDateTime("not-a-date")).toBe("-")
  })
})
