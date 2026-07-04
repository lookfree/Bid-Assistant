import type { CronJob } from "../services/cron"
import { expireDue } from "../services/credits"
import { DAY_MS } from "../services/renewal"
import { runReconcile, auditLedger, releaseOrphanHolds, scanStuckRefunds, toBillDate, type ReconcileProvider, type AlertHook } from "../services/reconcile"

// spec306 每日 Cron（spec303 startCronRunner 注册，集群单实例执行；注册即首跑，业务幂等去重）：
// - credit-expire / ledger-audit：纯账本关切，不依赖支付凭据，**始终注册**
//   （审计与孤儿 hold 清扫若被支付 gate 连坐，无凭据环境的 spec302 C1 修复会静默失效）；
// - reconcile：需通道 query 能力——与支付 Cron 同走 getPayment gate（凭据不齐整体跳过，不半开）。

/** 过期 job 体（可直调测试）：调账本 FIFO 过期（expire:<grantId> 幂等由 spec302 保证）。 */
export async function expireCreditsJob(): Promise<void> {
  const expired = await expireDue(new Date())
  console.info(`[cron:credit-expire] 过期注销积分 ${expired}`)
}

export function creditExpireCronJob(): CronJob {
  return { name: "credit-expire", everyMs: DAY_MS, jobFn: expireCreditsJob }
}

/** 账本审计 job 体（可直调测试）：余额=Σ流水审计 + 孤儿 hold 清扫 + 卡死退款扫描。
 *  三段各自隔离——任一段失败不吞后面的（都是独立的资金安全网）。 */
export async function ledgerAuditJob(deps: { alertHook?: AlertHook } = {}): Promise<void> {
  const results: string[] = []
  for (const [name, run] of [
    ["audit", async () => `bad=${(await auditLedger(undefined, deps.alertHook)).length}`],
    ["orphan-holds", async () => `released=${await releaseOrphanHolds(new Date(), deps)}`],
    ["stuck-refunds", async () => `stuck=${await scanStuckRefunds(new Date(), deps)}`],
  ] as const) {
    try {
      results.push(`${name}: ${await run()}`)
    } catch (err) {
      console.error(`[cron:ledger-audit] ${name} 失败（下轮重试）`, err)
    }
  }
  console.info(`[cron:ledger-audit] ${results.join(" | ")}`)
}

export function ledgerAuditCronJob(deps: { alertHook?: AlertHook } = {}): CronJob {
  return { name: "ledger-audit", everyMs: DAY_MS, jobFn: () => ledgerAuditJob(deps) }
}

/** 对账 job 体（可直调测试）：对昨日（UTC）账（窗口内已结算单 + 全量存量 unknown）。 */
export async function reconcileJob(deps: { provider: ReconcileProvider; alertHook?: AlertHook }): Promise<void> {
  const date = toBillDate(new Date(Date.now() - DAY_MS))
  const r = await runReconcile(date, deps)
  console.info(`[cron:reconcile] ${date} checked=${r.checked} diffs=${r.diffs}`)
}

export function reconcileCronJob(deps: { provider: ReconcileProvider; alertHook?: AlertHook }): CronJob {
  return {
    name: "reconcile",
    everyMs: DAY_MS,
    jobFn: () => reconcileJob(deps),
    watchdog: true, // 逐笔问通道，量大时是长任务：续租防锁过期被抢
  }
}
