import { hold as ledgerHold, settle as ledgerSettle, release } from "./credits"
import { InsufficientCreditsError } from "./credits-errors"

// Phase 3（spec302）：本模块从 stub 变为真账本的编排门面——实现全部委托 credits 服务，
// 文件名保留（spec300 接缝约定：只换实现不换挂点）。STEP_COST 常量已删，口径读 billing_configs。
// 结算口径 v1：编排层按操作口径全额结算（actualCost = 预扣 N）；按 token 计量的
// 「用量→积分」换算口径待商业定价定义后，编排层改传真实用量即启用多退少补。

/** 预扣：N = credit_cost.<op>。余额不足返回 ok:false（业务态）；配置缺失等基建错误照抛。 */
export async function preDeduct(
  userId: string,
  op: string,
  ref: string,
): Promise<{ ok: boolean; holdId?: string; hold: number }> {
  try {
    const { holdId, amount } = await ledgerHold(userId, op, { ref, idempotencyKey: `hold:${ref}` })
    return { ok: true, holdId, hold: amount }
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
