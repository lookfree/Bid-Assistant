import { describe, expect, it } from "bun:test"
import { authErrorMessage } from "@/lib/auth-errors"
import { ApiError } from "@/lib/api-client"

// 2026-08-06 用户反馈：「验证码还在 5 分钟有效期内，显示过期」。
// 根因是后端把「没有码/输错/错太多」压成同一个错误，前端一句「验证码错误或已过期」全包。
// 过期就说过期，没过期要如实告知真实原因——三种情况三句话。
describe("验证码失败原因分开说", () => {
  it("输错 → 说输错，不能提「过期」或「失效」", () => {
    const m = authErrorMessage(new ApiError(401, "invalid_code"), "x")
    expect(m).toContain("不正确")
    expect(m).not.toContain("过期")
    expect(m).not.toContain("失效")
  })

  it("真过期 → 说失效，并引导重新获取", () => {
    const m = authErrorMessage(new ApiError(401, "code_expired"), "x")
    expect(m).toContain("失效")
    expect(m).toContain("重新获取")
  })

  it("错太多次 → 说清是次数问题，别让用户以为是码本身的错", () => {
    const m = authErrorMessage(new ApiError(401, "code_too_many_attempts"), "x")
    expect(m).toContain("次数")
    expect(m).toContain("重新获取")
  })

  it("认不出的错误码回落调用方兜底文案", () => {
    expect(authErrorMessage(new ApiError(401, "brand_new"), "兜底")).toBe("兜底")
  })
})
