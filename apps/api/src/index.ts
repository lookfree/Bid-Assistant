import { createApp } from "./app"
import { getEnv } from "./config/env"
import { pingDb, closeDb } from "./db/client"
import { getRedis, closeRedis } from "./redis/client"
import { createSmsSender } from "./services/sms-sender"
import { makeSmsCodeService, type SmsLimits } from "./services/sms-code"
import { createCaptchaVerifier } from "./services/captcha"

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

const app = createApp({
  pingDb,
  smsCode,
  sessionTtlDays: env.AUTH_SESSION_TTL_DAYS,
  captchaEnabled: env.CAPTCHA_ENABLED,
  verifyCaptcha: (t) => captcha.verify(t),
  webOrigins: env.WEB_ORIGINS.split(",").map((s) => s.trim()),
})

// 优雅关闭：归还 DB 连接池与 Redis 连接，避免重启/热重载泄漏。
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void Promise.allSettled([closeDb(), closeRedis()]).finally(() => process.exit(0))
  })
}

export default { port: env.PORT, fetch: app.fetch }
