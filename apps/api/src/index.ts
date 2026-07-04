import { createApp } from "./app"
import { getEnv } from "./config/env"
import { pingDb, closeDb } from "./db/client"
import { getRedis, closeRedis } from "./redis/client"
import { closeS3 } from "./storage/s3"
import { createSmsSender } from "./services/sms-sender"
import { makeSmsCodeService, type SmsLimits } from "./services/sms-code"
import { createCaptchaVerifier } from "./services/captcha"
import { createWechatOAuthClient } from "./services/wechat-oauth"
import { makeWechatAuth } from "./services/wechat-auth"
import { startCronRunner } from "./services/cron"
import { sqbCheckinJob } from "./services/payment/terminal"
import { getPayment } from "./services/payment"
import { paymentOrderSweepJob } from "./services/payment-orders"
import { renewalCronJobs } from "./crons/renewal"
import { creditExpireCronJob, reconcileCronJob } from "./crons/billing"

const env = getEnv()

const limits: SmsLimits = {
  codeTtl: env.SMS_CODE_TTL_SECONDS,
  cooldownEnabled: env.SMS_COOLDOWN_ENABLED,
  cooldown: env.SMS_COOLDOWN_SECONDS,
  phoneLimitEnabled: env.SMS_PHONE_LIMIT_ENABLED,
  phoneHour: env.SMS_MAX_PER_PHONE_HOUR,
  phoneDay: env.SMS_MAX_PER_PHONE_DAY,
  ipLimitEnabled: env.SMS_IP_LIMIT_ENABLED,
  ipHour: env.SMS_MAX_PER_IP_HOUR,
  ipDay: env.SMS_MAX_PER_IP_DAY,
  attemptLimitEnabled: env.SMS_ATTEMPT_LIMIT_ENABLED,
  maxAttempts: env.SMS_MAX_VERIFY_ATTEMPTS,
}
const smsCode = makeSmsCodeService(getRedis(), createSmsSender(env), limits)
const captcha = createCaptchaVerifier(env)
const wechatService = makeWechatAuth(getRedis(), createWechatOAuthClient(env), env.AUTH_SESSION_TTL_DAYS)

const app = createApp({
  pingDb,
  smsCode,
  sessionTtlDays: env.AUTH_SESSION_TTL_DAYS,
  captchaEnabled: env.CAPTCHA_ENABLED,
  verifyCaptcha: (t) => captcha.verify(t),
  webOrigins: env.WEB_ORIGINS.split(",").map((s) => s.trim()),
  wechat: {
    service: wechatService,
    appId: env.WECHAT_APP_ID ?? "",
    redirectUri: env.WECHAT_REDIRECT_URI,
  },
})

// Cron 注册（分布式锁保集群单实例执行）：
// - 支付两个 job（每日签到 + 滞留单扫描）：gate 与路由同源 getPayment（不半开），缺凭据静默跳过；
// - 订阅状态推进：不依赖支付凭据，始终注册；
// - 到期提醒：通知渠道（短信模板/站内信）就绪后经 renewalCronJobs({ notify }) 接通——
//   无渠道不注册并在 renewalCronJobs 内告警（console 假发送会白耗去重档位，review-followups spec305 C10）。
const payment = getPayment()
const cron = startCronRunner([
  ...(payment ? [sqbCheckinJob(payment.terminal), paymentOrderSweepJob(payment.provider), reconcileCronJob({ provider: payment.provider })] : []),
  ...renewalCronJobs(),
  creditExpireCronJob(), // 积分过期：不依赖支付凭据，始终注册（spec306）
])

// 优雅关闭：先停 Cron 并等在途 tick 收尾，再归还 DB/Redis/S3 连接（顺序错了在途 tick 会打在已断连接上）。
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void (cron?.stopAll() ?? Promise.resolve())
      .then(() => Promise.allSettled([closeDb(), closeRedis(), closeS3()]))
      .finally(() => process.exit(0))
  })
}

export default { port: env.PORT, fetch: app.fetch }
