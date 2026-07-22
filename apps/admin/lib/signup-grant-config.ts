// 注册赠送配置（signup_grant_credits / grant_expire_days）的取值兜底与本地校验。
// 纯函数，供 signup-grant-card 与测试共用；校验规则与服务端 CONFIG_SCHEMAS 一致（非负整数）。

export type SignupGrantValues = {
  credits: number // 注册赠送积分（0=不送）
  expireDays: number // 赠送积分有效期天数（0=不过期）
}

export type SignupGrantErrors = Partial<Record<keyof SignupGrantValues, string>>

// 老库行可能缺键/存坏值：逐字段兜底到种子默认（credits=200、expireDays=0）。
export function toSignupGrantValues(configs: Record<string, unknown>): SignupGrantValues {
  const num = (v: unknown, dflt: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : dflt)
  return {
    credits: num(configs["signup_grant_credits"], 200),
    expireDays: num(configs["grant_expire_days"], 0),
  }
}

export function validateSignupGrant(v: SignupGrantValues): SignupGrantErrors {
  const errors: SignupGrantErrors = {}
  if (!Number.isInteger(v.credits) || v.credits < 0) errors.credits = "须为非负整数（0=不送）"
  if (!Number.isInteger(v.expireDays) || v.expireDays < 0) errors.expireDays = "须为非负整数（0=不过期）"
  return errors
}
