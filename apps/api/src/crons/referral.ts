import type { CronJob } from "../services/cron"
import { DAY_MS } from "../services/renewal"
import { sweepPendingReferralUnlocks } from "../services/referral"

// 推荐奖励重扫 Cron（R3）：兜底解锁发奖 best-effort 路径（markPaid 钩子 / bindByCode 立即发）
// 瞬时失败或崩溃留下的 bound+pending 关系。不依赖支付凭据，始终注册。

/** job 体（可直调测试）。 */
export async function referralUnlockSweepJob(): Promise<void> {
  const n = await sweepPendingReferralUnlocks()
  if (n > 0) console.info(`[cron:referral-unlock-sweep] 重驱解锁 ${n} 条`)
}

export function referralUnlockSweepCronJob(): CronJob {
  return { name: "referral-unlock-sweep", everyMs: DAY_MS, jobFn: referralUnlockSweepJob }
}
