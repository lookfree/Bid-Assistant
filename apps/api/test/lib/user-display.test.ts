import { describe, it, expect } from "bun:test"
import { maskPhone, userDisplayName } from "../../src/lib/user-display"

describe("用户展示名", () => {
  it("手机号打码保留前 3 后 4", () => {
    expect(maskPhone("13812345678")).toBe("138****5678")
  })

  it("过短的号码原样返回（不做假打码）", () => {
    expect(maskPhone("123456")).toBe("123456")
    expect(maskPhone(null)).toBe("")
  })

  it("昵称优先，其次打码手机号，都没有才回落 id", () => {
    expect(userDisplayName({ id: "u1", nickname: "老王", phone: "13812345678" })).toBe("老王")
    expect(userDisplayName({ id: "u1", nickname: null, phone: "13812345678" })).toBe("138****5678")
    expect(userDisplayName({ id: "u1" })).toBe("u1")
  })

  it("空昵称按没有处理，不显示成空白行", () => {
    expect(userDisplayName({ id: "u1", nickname: "", phone: "13812345678" })).toBe("138****5678")
  })
})
