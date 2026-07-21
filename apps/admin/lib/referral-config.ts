// 邀请奖励配置卡（spec327 Task B）：与 App API `/admin-api/plans/configs/referral_rules`
// 的 CONFIG_SCHEMAS 契约对齐的类型 + 纯逻辑。纯逻辑（无 React/DOM 依赖）单独放这里，便于
// bun test 直接测；组件只做渲染与状态编排（参照 apps/admin/lib/model-config.ts 的分层方式）。

export type UnlockOn = "" | "invitee_first_paid"

export type ReferralRules = {
  inviterReward: number
  inviteeReward: number
  unlockOn: UnlockOn
  capPerUser: number
  riskMaxPerIpPerHour: number
  abandonDays: number
}

// 读取回填的兜底默认值：老库行的 referral_rules 可能缺 abandonDays（历史种子只补缺不合并，
// 见 spec327 constraints），若原样提交给服务端会命中 strict 六键必填校验被 400。其余字段同理
// 逐个 ?? 兜底，防止任何历史脏数据缺字段时页面崩或原样提交被拒。
const DEFAULT_REFERRAL_RULES: ReferralRules = {
  inviterReward: 0,
  inviteeReward: 0,
  unlockOn: "",
  capPerUser: 0,
  riskMaxPerIpPerHour: 1,
  abandonDays: 0,
}

// 从 GET /admin-api/plans/configs 的全量 configs 中取 referral_rules 并逐字段兜底回填。
export function toReferralRules(configs: Record<string, unknown>): ReferralRules {
  const raw = (configs.referral_rules ?? {}) as Partial<ReferralRules>
  return {
    inviterReward: raw.inviterReward ?? DEFAULT_REFERRAL_RULES.inviterReward,
    inviteeReward: raw.inviteeReward ?? DEFAULT_REFERRAL_RULES.inviteeReward,
    unlockOn: raw.unlockOn ?? DEFAULT_REFERRAL_RULES.unlockOn,
    capPerUser: raw.capPerUser ?? DEFAULT_REFERRAL_RULES.capPerUser,
    riskMaxPerIpPerHour: raw.riskMaxPerIpPerHour ?? DEFAULT_REFERRAL_RULES.riskMaxPerIpPerHour,
    abandonDays: raw.abandonDays ?? DEFAULT_REFERRAL_RULES.abandonDays,
  }
}

// 独立键 reward_expire_days（int ≥ 0，天）：缺失/非数字时兜底 0。
export function toRewardExpireDays(configs: Record<string, unknown>): number {
  const v = configs.reward_expire_days
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

export type ReferralRulesErrors = Partial<Record<keyof ReferralRules, string>>

// 与服务端 apps/api/src/routes/admin/plans.ts CONFIG_SCHEMAS.referral_rules 同规则的本地校验：
// 两项奖励 int≥0、unlockOn 二选一、capPerUser int≥0 且 ≥ max(两奖励)、riskMaxPerIpPerHour int≥1、
// abandonDays int≥0。服务端 400 是扁平错误无字段明细，前端必须自己逐字段定位、提前拦截。
export function validateReferralRules(rules: ReferralRules): ReferralRulesErrors {
  const errors: ReferralRulesErrors = {}
  if (!Number.isInteger(rules.inviterReward) || rules.inviterReward < 0) {
    errors.inviterReward = "需为 ≥0 的整数"
  }
  if (!Number.isInteger(rules.inviteeReward) || rules.inviteeReward < 0) {
    errors.inviteeReward = "需为 ≥0 的整数"
  }
  if (rules.unlockOn !== "" && rules.unlockOn !== "invitee_first_paid") {
    errors.unlockOn = "非法解锁方式"
  }
  if (!Number.isInteger(rules.capPerUser) || rules.capPerUser < 0) {
    errors.capPerUser = "需为 ≥0 的整数"
  } else if (rules.capPerUser < Math.max(rules.inviterReward, rules.inviteeReward)) {
    errors.capPerUser = "需 ≥ 邀请人/被邀请人奖励中的较大值"
  }
  if (!Number.isInteger(rules.riskMaxPerIpPerHour) || rules.riskMaxPerIpPerHour < 1) {
    errors.riskMaxPerIpPerHour = "需为 ≥1 的整数"
  }
  if (!Number.isInteger(rules.abandonDays) || rules.abandonDays < 0) {
    errors.abandonDays = "需为 ≥0 的整数"
  }
  return errors
}

export function isReferralRulesValid(rules: ReferralRules): boolean {
  return Object.keys(validateReferralRules(rules)).length === 0
}

// reward_expire_days 校验：int ≥ 0。undefined 表示合法。
export function validateRewardExpireDays(days: number): string | undefined {
  return Number.isInteger(days) && days >= 0 ? undefined : "需为 ≥0 的整数"
}

// 保存前构造 PUT body 的纯函数：只取六个已知键重建对象，防止内部状态意外携带额外字段
// （服务端 .strict() 校验遇到未知键会把整份请求连坐拒绝为 400 invalid_input）。
export function toReferralRulesPayload(rules: ReferralRules): ReferralRules {
  const { inviterReward, inviteeReward, unlockOn, capPerUser, riskMaxPerIpPerHour, abandonDays } = rules
  return { inviterReward, inviteeReward, unlockOn, capPerUser, riskMaxPerIpPerHour, abandonDays }
}
