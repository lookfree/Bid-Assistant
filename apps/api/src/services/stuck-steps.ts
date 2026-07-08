import { and, eq } from "drizzle-orm"
import { getDb } from "../db/client"
import { projectSteps, creditTransactions } from "../db/schema"
import { release } from "./credits"

// 卡死 running 步惰性自愈（生产实测问题）：步进请求的 DB 连接中途断掉 → finishStep 的异常路径
// 也打在断连接上 → 占位行永远停在 running。部分唯一索引 (project_id, step) WHERE status='running'
// 会让该步后续所有重试恒 409 step_already_running，且预扣的积分被冻结。
// 修法走请求路径（不新增 Cron）：POST steps 撞唯一索引时判定既有行死活——死行当场置 failed +
// 退还预扣，然后放行本次新请求；钱的深度兜底仍是既有 releaseOrphanHolds（24h 孤儿 hold 清扫）。

/** 判死阈值：正常步 1-10 分钟收尾，running 超过 10 分钟即按死行自愈。 */
export const STUCK_STEP_MAX_AGE_MS = 10 * 60_000

/** 只需要查 run 终态的能力（与 agent-client.getRun 兼容，路由测试注入 mock）。 */
export type GetRunFn = (runId: string) => Promise<{ status: string }>

/** 判定 running 占位行是否已死：行龄超阈值；或其 agent run 已 failed / 查无（status 缺失）——
 *  run 已终结而 App 侧收尾没执行（连接断）。agent 不可达时按活处理（宁可 409 也不误杀活 run）。 */
async function isDeadStep(
  row: { createdAt: Date; runId: string | null },
  getRun: GetRunFn,
  now: Date,
): Promise<boolean> {
  if (now.getTime() - row.createdAt.getTime() > STUCK_STEP_MAX_AGE_MS) return true
  if (!row.runId) return false // 新行且 run 还没建好：再等等（超龄后自然判死）
  try {
    const run = await getRun(row.runId)
    return run.status === "failed" || run.status == null
  } catch {
    return false
  }
}

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

/** 撞 409 后的惰性自愈入口：查该步现存 running 行——
 *  死行 → 清理（置 failed + 退钱）后返回 true（调用方可重试插占位行）；
 *  活行 → false（如实 409）；行已消失 → true（冲突对象已被并发收尾）。 */
export async function healStuckStep(
  projectId: string,
  step: string,
  getRun: GetRunFn,
  now: Date = new Date(),
): Promise<boolean> {
  const [row] = await getDb()
    .select()
    .from(projectSteps)
    .where(and(eq(projectSteps.projectId, projectId), eq(projectSteps.step, step), eq(projectSteps.status, "running")))
  if (!row) return true
  if (!(await isDeadStep(row, getRun, now))) return false
  await failStepAndRefund(row.id)
  return true // 翻转是谁完成的不重要：死行已被清理，均可重试插入
}
