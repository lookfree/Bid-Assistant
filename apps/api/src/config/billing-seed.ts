// 联调占位配置（★非真实定价）；spec310 运营后台 UI 接管写同一张 billing_configs。
// 键约定：credit_cost.<op> / recharge_packs / credit_rate / *_expire_days / referral_rules /
// renewal_reminder_days / renewal_grace_days / payment_poll。
export const BILLING_SEED: Record<string, unknown> = {
  // 各操作积分口径（占位统一 10；真实口径由运营配置）
  "credit_cost.read": 10,
  "credit_cost.outline": 10,
  "credit_cost.content": 10,
  "credit_cost.review": 10,
  "credit_cost.present": 10,
  "credit_cost.export": 10,
  // 充值包（金额分 → 到账积分）；每项带稳定 id；到账以 pack.credits 为准（含赠送），
  // credit_rate 仅用于无包任意金额充值（正向换算）
  recharge_packs: [
    { id: "pack_100", amountCents: 100, credits: 100 },
    { id: "pack_1000", amountCents: 1000, credits: 1100 },
  ],
  credit_rate: { credits_per_cny_cent: 1 }, // 正向汇率：credits = floor(amountCents × credits_per_cny_cent)（占位 1 分=1 积分）
  grant_expire_days: 30, // 赠送积分有效期
  reward_expire_days: 30, // 奖励积分有效期
  referral_rules: {
    inviterReward: 50,
    inviteeReward: 50,
    unlockOn: "invitee_first_paid",
    capPerUser: 500,
    riskMaxPerIpPerHour: 20, // 占位，spec307 风控阈值不写死
  },
  renewal_reminder_days: [7, 3, 1], // 到期提醒天数档（T-7/T-3/T-1）
  renewal_grace_days: 3, // past_due 宽限期（天）
  payment_poll: { windowMinutes: 6, fastSeconds: 3, slowSeconds: 10 }, // 收钱吧结果轮询窗口（官方规范）
}
