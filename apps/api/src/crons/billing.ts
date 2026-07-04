import type { CronJob } from "../services/cron"
import { expireDue } from "../services/credits"
import { runReconcile, auditLedger, releaseOrphanHolds, type ReconcileProvider, type AlertHook } from "../services/reconcile"

// spec306 每日 Cron（spec303 startCronRunner 注册，集群单实例执行；注册即首跑，业务幂等键去重）：
// - credit-expire：不依赖支付凭据，始终注册；
// - reconcile：需通道 query 能力——与支付 Cron 同走 getPayment gate（凭据不齐整体跳过，不半开）。

const DAY_MS = 86_400_000

/** 过期 job 体（可直调测试）：调账本 FIFO 过期（expire:<grantId> 幂等由 spec302 保证）。 */
export async function expireCreditsJob(): Promise<void> {
  const expired = await expireDue(new Date())
  console.info(`[cron:credit-expire] 过期注销积分 ${expired}`)
}

export function creditExpireCronJob(): CronJob {
  return {
    name: "credit-expire",
    everyMs: DAY_MS,
    jobFn: expireCreditsJob,
  }
}

/** 对账 job 体（可直调测试）：对昨日（UTC）账 + 账本审计 + 孤儿 hold 清扫。 */
export async function reconcileJob(deps: { provider: ReconcileProvider; alertHook?: AlertHook }): Promise<void> {
  const date = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10)
  const r = await runReconcile(date, deps)
  const bad = await auditLedger(date, deps.alertHook)
  const orphans = await releaseOrphanHolds(new Date(), { alertHook: deps.alertHook })
  console.info(`[cron:reconcile] ${date} checked=${r.checked} diffs=${r.diffs} ledgerBad=${bad.length} orphanHolds=${orphans}`)
}

export function reconcileCronJob(deps: { provider: ReconcileProvider; alertHook?: AlertHook }): CronJob {
  return {
    name: "reconcile",
    everyMs: DAY_MS,
    jobFn: () => reconcileJob(deps),
    watchdog: true, // 逐笔问通道，量大时是长任务：续租防锁过期被抢
  }
}
