import type { CronJob } from "../services/cron"
import { advanceSubscriptionStates, scanRenewalReminders, DAY_MS, type ReminderNotice } from "../services/renewal"

// spec305 每日 Cron（spec303 startCronRunner 注册，集群单实例执行；注册即首跑）：
// - subscription-state 始终注册（纯 DB 推进，条件 UPDATE 幂等）；
// - renewal-remind 只在显式提供 notify 渠道时注册——不给 console 假渠道：
//   假发送会消耗 renewal_reminders 去重档位，等于把提醒静默吞掉且事后无法补发。
//   短信模板/站内信就绪后在入口传入 notify 即接通（接口见 services/renewal.ReminderNotice）。

export function renewalCronJobs(deps: { notify?: (n: ReminderNotice) => Promise<void> } = {}): CronJob[] {
  const jobs: CronJob[] = [
    {
      name: "subscription-state",
      everyMs: DAY_MS,
      jobFn: async () => {
        await advanceSubscriptionStates(new Date())
      },
    },
  ]
  const notify = deps.notify
  if (notify) {
    jobs.unshift({
      name: "renewal-remind",
      everyMs: DAY_MS,
      jobFn: async () => {
        await scanRenewalReminders(new Date(), { notify })
      },
    })
  }
  return jobs
}
