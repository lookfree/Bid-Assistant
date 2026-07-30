import { hold as ledgerHold, settle as ledgerSettle, release } from "./credits"
import { InsufficientCreditsError } from "./credits-errors"
import { contentTiers, costForChars, holdAmountFor, settleAmountFor } from "./content-pricing"

// Phase 3（spec302）：本模块从 stub 变为真账本的编排门面——实现全部委托 credits 服务，
// 文件名保留（spec300 接缝约定：只换实现不换挂点）。STEP_COST 常量已删，口径读 billing_configs。
// 结算口径：各步按真实配置键 credit_cost.<op> 扣费（read/outline/review/present/export 直用同名键）；
// content 步按产出总字数走计费阶梯（credit_cost.content_tiers），见下方 resolveStepHoldAmount / settleContent。

/** 步 → 预扣金额。content 按**用户选定目标字数落到的档位**预扣（用户口径 2026-07-30：
 *  选了「≤5万字 40 积分」那档，账上有 40 就该能开跑；此前无论选哪档都固定预扣最高档 260 积分，
 *  余额 100 时选最低档反而弹「积分不足」，与弹层文案"按实际产出字数分档结算"自相矛盾）。
 *  没传目标字数（旧调用/export 步）时退回最高档预扣，行为不变——那种情况没有"用户选的档"可依据。
 *  代价：若实际产出显著超出所选目标字数落进更高档（如选 1 万字却写出 6 万字），结算封顶在预扣额
 *  （settleAmountFor 的 Math.min），平台少收而非追加扣款——用户已明确接受这个方向。
 *  其余步返回 undefined，表示按 credit_cost.<step> 取值（路径不变）。
 *  阶梯缺失/非法时抛错——调用方必须在「占步位/预扣之前」捕获并转 400，
 *  对齐 model_not_configured 口径：不占步位、不预扣、不静默按默认价扣费。 */
export async function resolveStepHoldAmount(step: string, targetChars?: number): Promise<number | undefined> {
  if (step !== "content") return undefined
  const tiers = await contentTiers()
  return targetChars ? costForChars(tiers, targetChars) : holdAmountFor(tiers)
}

/** content 步结算：按本次产出的正文总字数落档，并钳到 ≤ heldAmount
 *  （防误配把结算算成少补 → 扣穿；也保证发版时在途 run 按旧预扣额安全收尾）。
 *  阶梯读取失败即抛错，绝不静默按 0 收费。返回实际计费额。 */
export async function settleContent(
  ref: string,
  holdId: string,
  heldAmount: number,
  totalChars: number,
): Promise<number> {
  const cost = settleAmountFor(await contentTiers(), totalChars, heldAmount)
  await ledgerSettle(holdId, cost, { idempotencyKey: `settle:${ref}` })
  return cost
}

/** 预扣：金额优先用显式 amount（content 阶梯），否则 N = credit_cost.<op>。
 *  余额不足返回 ok:false（业务态）；配置缺失等基建错误照抛。 */
export async function preDeduct(
  userId: string,
  op: string,
  ref: string,
  amount?: number,
): Promise<{ ok: boolean; holdId?: string; hold: number }> {
  try {
    const { holdId, amount: held } = await ledgerHold(userId, op, {
      ref,
      idempotencyKey: `hold:${ref}`,
      ...(amount !== undefined ? { amount } : {}),
    })
    return { ok: true, holdId, hold: held }
  } catch (e) {
    if (e instanceof InsufficientCreditsError) return { ok: false, hold: 0 }
    throw e
  }
}

/** 成功结算：净消耗 = actualCost（多退少补），返回实际计费额。幂等键=settle:<ref>。 */
export async function settle(ref: string, holdId: string, actualCost: number): Promise<number> {
  await ledgerSettle(holdId, actualCost, { idempotencyKey: `settle:${ref}` })
  return actualCost
}

/** 失败退还：hold 全额退回（净 0）。幂等键=release:<ref>。 */
export async function settleFailed(ref: string, holdId: string): Promise<void> {
  await release(holdId, { idempotencyKey: `release:${ref}` })
}
