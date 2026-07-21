import { describe, it, expect } from "bun:test"
import {
  toReferralRules,
  toRewardExpireDays,
  toReferralRulesPayload,
  validateReferralRules,
  isReferralRulesValid,
  validateRewardExpireDays,
  type ReferralRules,
} from "../lib/referral-config"

const VALID_RULES: ReferralRules = {
  inviterReward: 50,
  inviteeReward: 50,
  unlockOn: "invitee_first_paid",
  capPerUser: 500,
  riskMaxPerIpPerHour: 20,
  abandonDays: 7,
}

describe("spec327 referral-config: toReferralRules", () => {
  it("完整 referral_rules 原样读出", () => {
    expect(toReferralRules({ referral_rules: VALID_RULES })).toEqual(VALID_RULES)
  })

  it("老库行缺 abandonDays → 兜底补 0（关键坑：否则原样提交会被 strict 校验 400）", () => {
    const { abandonDays: _drop, ...legacy } = VALID_RULES
    const rules = toReferralRules({ referral_rules: legacy })
    expect(rules.abandonDays).toBe(0)
    expect(isReferralRulesValid(rules)).toBe(true)
  })

  it("referral_rules 键完全缺失 → 全部兜底默认值，且默认值本身合法", () => {
    const rules = toReferralRules({})
    expect(isReferralRulesValid(rules)).toBe(true)
  })
})

describe("spec327 referral-config: toRewardExpireDays", () => {
  it("正常读出", () => {
    expect(toRewardExpireDays({ reward_expire_days: 30 })).toBe(30)
  })
  it("缺失/非数字 → 兜底 0", () => {
    expect(toRewardExpireDays({})).toBe(0)
    expect(toRewardExpireDays({ reward_expire_days: "30" })).toBe(0)
  })
})

describe("spec327 referral-config: validateReferralRules", () => {
  it("合法六键 → 无错误", () => {
    expect(validateReferralRules(VALID_RULES)).toEqual({})
    expect(isReferralRulesValid(VALID_RULES)).toBe(true)
  })

  it("负数奖励 → 标红对应字段", () => {
    const errors = validateReferralRules({ ...VALID_RULES, inviterReward: -1 })
    expect(errors.inviterReward).toBeDefined()
    expect(errors.inviteeReward).toBeUndefined()
  })

  it("非整数（小数）→ 标红", () => {
    const errors = validateReferralRules({ ...VALID_RULES, inviteeReward: 1.5 })
    expect(errors.inviteeReward).toBeDefined()
  })

  it("坏枚举 unlockOn → 标红", () => {
    const errors = validateReferralRules({ ...VALID_RULES, unlockOn: "bad_enum" as ReferralRules["unlockOn"] })
    expect(errors.unlockOn).toBeDefined()
  })

  it("capPerUser < max(两奖励) → 标红 capPerUser", () => {
    const errors = validateReferralRules({ ...VALID_RULES, inviterReward: 100, inviteeReward: 100, capPerUser: 50 })
    expect(errors.capPerUser).toBeDefined()
  })

  it("riskMaxPerIpPerHour < 1 → 标红", () => {
    expect(validateReferralRules({ ...VALID_RULES, riskMaxPerIpPerHour: 0 }).riskMaxPerIpPerHour).toBeDefined()
  })

  it("abandonDays 负数 → 标红；缺字段兜底为 0 后合法", () => {
    expect(validateReferralRules({ ...VALID_RULES, abandonDays: -1 }).abandonDays).toBeDefined()
    const { abandonDays: _drop, ...legacy } = VALID_RULES
    const backfilled = toReferralRules({ referral_rules: legacy })
    expect(validateReferralRules(backfilled)).toEqual({})
  })
})

describe("spec327 referral-config: validateRewardExpireDays", () => {
  it("非负整数 → 合法", () => {
    expect(validateRewardExpireDays(30)).toBeUndefined()
    expect(validateRewardExpireDays(0)).toBeUndefined()
  })
  it("负数/小数/NaN → 非法", () => {
    expect(validateRewardExpireDays(-1)).toBeDefined()
    expect(validateRewardExpireDays(1.5)).toBeDefined()
    expect(validateRewardExpireDays(NaN)).toBeDefined()
  })
})

describe("spec327 referral-config: toReferralRulesPayload（保存请求体形状断言）", () => {
  it("只保留六个已知键，剔除意外携带的额外字段", () => {
    const withExtra = { ...VALID_RULES, extraneous: "should not be sent" } as ReferralRules & { extraneous: string }
    const payload = toReferralRulesPayload(withExtra)
    expect(payload).toEqual(VALID_RULES)
    expect(Object.keys(payload).sort()).toEqual(
      ["abandonDays", "capPerUser", "inviteeReward", "inviterReward", "riskMaxPerIpPerHour", "unlockOn"].sort(),
    )
  })
})
