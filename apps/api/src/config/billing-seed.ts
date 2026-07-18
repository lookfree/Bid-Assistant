// 联调占位配置（★非真实定价）；spec310 运营后台 UI 接管写同一张 billing_configs。
// 键约定：credit_cost.<op> / recharge_packs / credit_rate / *_expire_days / referral_rules /
// renewal_reminder_days / renewal_grace_days / payment_poll。
import { CREDIT_COST_ITEMS } from "./credit-cost-items"

// 各操作积分口径 credit_cost.<key>：9 项以 C 端「积分消耗说明」为准（见 credit-cost-items.ts），运营后台可改。
const creditCostSeed = Object.fromEntries(CREDIT_COST_ITEMS.map((i) => [`credit_cost.${i.key}`, i.default]))

export const BILLING_SEED: Record<string, unknown> = {
  ...creditCostSeed,
  // 充值包（金额分 → 到账积分）；每项带稳定 id；到账以 pack.credits 为准（含赠送），
  // credit_rate 仅用于无包任意金额充值（正向换算）
  recharge_packs: [
    { id: "pack_100", amountCents: 100, credits: 100 },
    { id: "pack_1000", amountCents: 1000, credits: 1100 },
  ],
  credit_rate: { credits_per_cny_cent: 1 }, // 正向汇率：credits = floor(amountCents × credits_per_cny_cent)（占位 1 分=1 积分）
  grant_expire_days: 30, // 赠送积分有效期
  reward_expire_days: 30, // 奖励积分有效期
  signup_grant_credits: 200, // 首次注册一次性赠送积分（运营后台可改；0 = 不赠送）
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
  // 智能体模型选择（spec311）：运营后台可配，覆盖 agent env 默认；API Key 仍在 env。
  // provider ∈ deepseek/qwen/glm；model=null 用 provider 默认模型；fallbacks 形如 "qwen:qwen-plus,glm:glm-4-flash"
  agent_model: { provider: "deepseek", model: null, fallbacks: "" },
  // 资料库 RAG 检索（spec316）：运营后台可关闭/调整 top_k；node 从 run_input.rag 读取。
  "rag.enabled": true,
  "rag.top_k": 3,
}
