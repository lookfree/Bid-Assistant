import { and, eq } from "drizzle-orm"
import { getDb } from "../db/client"
import { projectSteps, creditTransactions } from "../db/schema"
import { release } from "./credits"

// 卡死 running 步的「判死收尾」原语（生产实测问题）：步进请求的 DB 连接中途断掉 → finishStep
// 的异常路径也打在断连接上 → 占位行永远停在 running。部分唯一索引 (project_id, step)
// WHERE status='running' 会让该步后续所有重试恒 409 step_already_running，且预扣的积分被冻结。
// 死活判定与收尾编排（含成功结果的对账恢复）在 step-finalize.ts（spec327 janitor 加固）：
// 409 惰性自愈 healStuckStep + 5 分钟对账 Cron sweepStuckSteps 共用；本文件只留
// 「置 failed + 退款」这一原子动作与判龄阈值。

/** 超龄阈值：running 超过 10 分钟才进入对账判定（正常步 1-10 分钟收尾）。 */
export const STUCK_STEP_MAX_AGE_MS = 10 * 60_000

/** 死行收尾：事务内「条件置 failed + 退还该步预扣」原子提交（钱从严）。
 *  条件更新（WHERE status='running'）是并发唯一了结点：两个请求同时自愈同一行，
 *  只有翻转成功的那个退钱，另一个空手而归——绝不双退。
 *  退还完全复用账本 release：幂等键 release:<stepId> 与 settleFailed 同口径，
 *  了结部分唯一索引（每 hold 至多一条 settle/release）在 DB 层杜绝与迟到 settle 双记；
 *  release 内部真退还才刷新余额缓存（与 releaseOrphanHolds 走的同一机制）。
 *  返回本次是否完成了翻转（false=并发已治愈/已收尾）。 */
export async function failStepAndRefund(stepId: string): Promise<boolean> {
  return await getDb().transaction(async (tx) => {
    const flipped = await tx
      .update(projectSteps)
      .set({ status: "failed" })
      .where(and(eq(projectSteps.id, stepId), eq(projectSteps.status, "running")))
      .returning({ id: projectSteps.id })
    if (flipped.length === 0) return false
    // 本次步进的预扣：按幂等键 hold:<stepId> 精确定位（preDeduct 的既定键格式，唯一索引兜底至多一条）。
    // 注意 ref 口径：hold 行 ref=stepId，但 settle/release 行 ref=holdId——凭幂等键找才不混。
    const [h] = await tx
      .select()
      .from(creditTransactions)
      .where(and(eq(creditTransactions.type, "hold"), eq(creditTransactions.idempotencyKey, `hold:${stepId}`)))
    // 无 hold（预扣前挂的行）只置 failed；已有了结引用时 release 内部 onConflictDoNothing 吞掉
    if (h) await release(h.id, { idempotencyKey: `release:${stepId}` }, tx)
    return true
  })
}

