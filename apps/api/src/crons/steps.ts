import type { CronJob } from "../services/cron"
import { getRun } from "../services/agent-client"
import { sweepStuckSteps } from "../services/step-finalize"

// spec327 卡死步对账 Cron：旧机制纯惰性（409 撞车才自愈,用户不点重试就永远卡 running,
// 发版前还要手工 failStepAndRefund）。这里 5 分钟一轮扫超龄 running 行,问 agent 要 run
// 真实终态——成功的收尾交付（settle+落结果+推进）,失败/查无的置 failed+退款,活着的放行。
// 全部动作幂等（settle:/release:<stepId> + 条件翻转）,与请求路径并发收尾安全。

const EVERY_MS = 5 * 60_000

/** job 体（可直调测试）。 */
export async function stuckStepsJob(): Promise<void> {
  const counts = await sweepStuckSteps(getRun)
  if (counts.recovered || counts.failed) {
    console.info(`[cron:stuck-steps] recovered=${counts.recovered} failed=${counts.failed} alive=${counts.alive}`)
  }
}

export function stuckStepsCronJob(): CronJob {
  return { name: "stuck-steps", everyMs: EVERY_MS, jobFn: stuckStepsJob }
}
