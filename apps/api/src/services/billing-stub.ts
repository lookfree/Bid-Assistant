import { hold as ledgerHold, settle as ledgerSettle, release } from "./credits"
import { InsufficientCreditsError } from "./credits-errors"
import { contentTiers, holdAmountFor, settleAmountFor } from "./content-pricing"

// Phase 3（spec302）：本模块从 stub 变为真账本的编排门面——实现全部委托 credits 服务，
// 文件名保留（spec300 接缝约定：只换实现不换挂点）。STEP_COST 常量已删，口径读 billing_configs。
// 结算口径：各步按真实配置键 credit_cost.<op> 扣费（read/outline/review/present/export 直用同名键）；
// content 步按产出总字数走计费阶梯（credit_cost.content_tiers），见下方 resolveStepHoldAmount / settleContent。

/** 步 → 预扣金额。content 按计费阶梯的最大价预扣（结算只多退不少补）；
 *  其余步返回 undefined，表示按 credit_cost.<step> 取值（路径不变）。
 *  阶梯缺失/非法时抛错——调用方必须在「占步位/预扣之前」捕获并转 400，
 *  对齐 model_not_configured 口径：不占步位、不预扣、不静默按默认价扣费。 */
export async function resolveStepHoldAmount(step: string): Promise<number | undefined> {
  if (step !== "content") return undefined
  return holdAmountFor(await contentTiers())
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
