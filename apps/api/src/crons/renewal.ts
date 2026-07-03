import type { CronJob } from "../services/cron"
import { advanceSubscriptionStates, scanRenewalReminders, type ReminderNotice } from "../services/renewal"

// spec305 两个每日 Cron（spec303 startCronRunner 注册，集群单实例执行；注册即首跑）：
// 提醒/状态推进都以 DB 为准扫描 + 业务幂等（提醒落库去重、状态条件 UPDATE），双触发无副作用。
// 不依赖支付 provider——与支付 Cron 的凭据 gate 无关，始终注册。

const DAY_MS = 86_400_000

export function renewalCronJobs(deps: { notify?: (n: ReminderNotice) => Promise<void> } = {}): CronJob[] {
  return [
    {
      name: "renewal-remind",
      everyMs: DAY_MS,
      jobFn: async () => {
        await scanRenewalReminders(new Date(), deps)
      },
    },
    {
      name: "subscription-state",
      everyMs: DAY_MS,
      jobFn: async () => {
        await advanceSubscriptionStates(new Date())
      },
    },
  ]
}
