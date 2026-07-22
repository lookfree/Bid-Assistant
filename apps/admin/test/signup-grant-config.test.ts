import { describe, it, expect } from "bun:test"
import { toSignupGrantValues, validateSignupGrant } from "../lib/signup-grant-config"

describe("注册赠送配置：取值兜底与校验", () => {
  it("正常取值：两键都在", () => {
    expect(toSignupGrantValues({ signup_grant_credits: 500, grant_expire_days: 7 })).toEqual({ credits: 500, expireDays: 7 })
  })

  it("缺键/坏值逐字段兜底到种子默认（credits=200、expireDays=0）", () => {
    expect(toSignupGrantValues({})).toEqual({ credits: 200, expireDays: 0 })
    expect(toSignupGrantValues({ signup_grant_credits: "bad", grant_expire_days: -3 })).toEqual({ credits: 200, expireDays: 0 })
  })

  it("校验：非负整数通过，负数/小数/NaN 逐字段标错", () => {
    expect(validateSignupGrant({ credits: 0, expireDays: 0 })).toEqual({})
    expect(validateSignupGrant({ credits: -1, expireDays: 1.5 })).toEqual({
      credits: "须为非负整数（0=不送）",
      expireDays: "须为非负整数（0=不过期）",
    })
    expect(Object.keys(validateSignupGrant({ credits: NaN, expireDays: 30 }))).toEqual(["credits"])
  })
})
