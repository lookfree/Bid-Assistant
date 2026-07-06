import { hold as ledgerHold, settle as ledgerSettle, release } from "./credits"
import { InsufficientCreditsError } from "./credits-errors"
import { getConfig } from "./config"

// Phase 3（spec302）：本模块从 stub 变为真账本的编排门面——实现全部委托 credits 服务，
// 文件名保留（spec300 接缝约定：只换实现不换挂点）。STEP_COST 常量已删，口径读 billing_configs。
// 结算口径：各步按真实配置键 credit_cost.<op> 扣费（read/outline/review/present/export 直用同名键）；
// content 步按篇幅分档（content_short/content_long），见下方 holdOpForStep / settleContent。

// content 步「按篇幅分档」阈值：任一章正文（剥 HTML 标签后）> 2000 字即长篇档，
// 对齐 C 端「积分消耗说明」口径「单章 > 2000 字」。
export const CONTENT_LONG_CHAR_THRESHOLD = 2000

/** 步 → 预扣用的积分口径 op。
 *  content 特殊：产出长度在预扣时未知，先按【上档 content_long】预扣，结算再按实际落档
 *  （settle 只多退不少补，绝不把结算算成超过预扣而扣穿余额）。
 *  其余步直接用同名 credit_cost.<step>（read/outline/review/present/export 均为真实配置键）。 */
export function holdOpForStep(step: string): string {
  return step === "content" ? "content_long" : step
}

/** content 步结算：任一章 > 阈值 → 长篇档（足额 = 预扣的 content_long，即 heldAmount）；
 *  否则短篇档 content_short（退差额）。短篇价按真实配置读取，并钳到 ≤ heldAmount
 *  （防误配 short>long 把结算算成少补 → 扣穿）。缺短篇口径即失败，杜绝静默免费。返回实际计费额。 */
export async function settleContent(
  ref: string,
  holdId: string,
  heldAmount: number,
  maxChapterChars: number,
): Promise<number> {
  let cost = heldAmount // 长篇档：足额结算（= 预扣的 content_long）
  if (maxChapterChars <= CONTENT_LONG_CHAR_THRESHOLD) {
    const short = await getConfig<number>("credit_cost.content_short")
    if (short == null) throw new Error("未配置操作积分口径 credit_cost.content_short")
    cost = Math.min(Number(short), heldAmount)
  }
  await ledgerSettle(holdId, cost, { idempotencyKey: `settle:${ref}` })
  return cost
}

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
