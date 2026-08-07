/**
 * agent 失败原因能不能直接给用户看。
 *
 * 2026-08-07 生产：一份盖章扫描件在 1 分钟内触发 21 次审查——agent 每次都准确回了
 * 「上传的标书未能解析出任何正文（扫描件/图片版暂不支持）」，但这句话止步于 agent，
 * 前端只能显示「生成失败，请重试」，于是用户一直重试一个**永远不会成功**的操作。
 *
 * 放行的边界必须守住：只有我们自己写给用户的 RuntimeError 文案能外露；代码 bug 的原始异常
 * （`invalid literal for int() with base 10: 'wer'` 这种线上真实出现过的）对用户毫无意义，
 * 还可能带出内部结构。
 */
import { describe, it, expect } from "bun:test"
import { userFacingRunError } from "../../src/services/agent-client"

describe("userFacingRunError", () => {
  it("我们写给用户的 RuntimeError 文案 → 原样放行", () => {
    const msg = "上传的标书未能解析出任何正文（扫描件/图片版暂不支持），请上传可复制文字的 docx/pdf 后重试"
    expect(userFacingRunError({ error: msg, errorType: "RuntimeError" })).toBe(msg)
  })

  it("代码 bug 的原始异常 → 不外露", () => {
    // 线上真实出现过这条
    expect(userFacingRunError({ error: "invalid literal for int() with base 10: 'wer'", errorType: "ValueError" })).toBeNull()
    expect(userFacingRunError({ error: "boom", errorType: "TypeError" })).toBeNull()
  })

  it("带栈的一律不外露——兜底，别把内部结构喂给用户", () => {
    expect(userFacingRunError({ error: 'Traceback (most recent call last):\n  File "/app/x.py"', errorType: "RuntimeError" })).toBeNull()
  })

  it("空原因/缺字段 → null，由调用方回落通用文案", () => {
    expect(userFacingRunError({ error: "", errorType: "RuntimeError" })).toBeNull()
    expect(userFacingRunError({ error: "   ", errorType: "RuntimeError" })).toBeNull()
    expect(userFacingRunError({})).toBeNull()
    expect(userFacingRunError({ error: "有原因但没类型" })).toBeNull()
  })

  it("过长截断：横幅是一行提示，不是日志", () => {
    const out = userFacingRunError({ error: "字".repeat(500), errorType: "RuntimeError" })
    expect(out!.length).toBeLessThanOrEqual(200)
  })
})
