import { randomInt } from "node:crypto"
import type { Redis } from "ioredis"
import type { SmsSender } from "./sms-sender"

export type SmsLimits = {
  codeTtl: number
  cooldownEnabled: boolean
  cooldown: number
  phoneLimitEnabled: boolean
  phoneHour: number
  phoneDay: number
  ipLimitEnabled: boolean
  ipHour: number
  ipDay: number
  attemptLimitEnabled: boolean
  maxAttempts: number
}
export type SmsRequestInput = { phone: string; ip?: string }
export type SmsRequestResult =
  | { ok: true }
  | { ok: false; reason: "cooldown" | "rate_limited"; retryAfter?: number }

export type SmsCodeService = {
  request(input: SmsRequestInput): Promise<SmsRequestResult>
  verify(phone: string, code: string): Promise<boolean>
}

export function makeSmsCodeService(redis: Redis, sender: SmsSender, limits: SmsLimits): SmsCodeService {
  // 固定窗口计数：首次自增时设过期。
  const bump = async (key: string, win: number): Promise<number> => {
    const n = await redis.incr(key)
    if (n === 1) await redis.expire(key, win)
    return n
  }

  return {
    async request({ phone, ip }) {
      const cd = `sms:cd:${phone}`
      // ① 同号冷却（可关）
      if (limits.cooldownEnabled) {
        const ttl = await redis.ttl(cd)
        if (ttl > 0) return { ok: false, reason: "cooldown", retryAfter: ttl }
      }

      // ②③ 同号 / 同 IP 时·日限频（各自可关；先读判，未触顶才发）
      const windows: Array<{ key: string; cap: number; win: number }> = []
      if (limits.phoneLimitEnabled) {
        windows.push(
          { key: `sms:ph:1h:${phone}`, cap: limits.phoneHour, win: 3600 },
          { key: `sms:ph:1d:${phone}`, cap: limits.phoneDay, win: 86400 },
        )
      }
      if (limits.ipLimitEnabled && ip) {
        windows.push(
          { key: `sms:ip:1h:${ip}`, cap: limits.ipHour, win: 3600 },
          { key: `sms:ip:1d:${ip}`, cap: limits.ipDay, win: 86400 },
        )
      }
      for (const w of windows) {
        if (Number((await redis.get(w.key)) ?? 0) >= w.cap) return { ok: false, reason: "rate_limited" }
      }

      const code = String(randomInt(100000, 1000000))
      await redis.set(`sms:code:${phone}`, code, "EX", limits.codeTtl)
      await redis.del(`sms:att:${phone}`) // 重置尝试计数
      if (limits.cooldownEnabled) await redis.set(cd, "1", "EX", limits.cooldown)
      for (const w of windows) await bump(w.key, w.win)
      await sender.send(phone, code)
      return { ok: true }
    },

    async verify(phone, code) {
      const codeKey = `sms:code:${phone}`
      const stored = await redis.get(codeKey)
      if (!stored) return false
      // ④ 尝试上限（可关）：超次作废
      if (limits.attemptLimitEnabled) {
        const attempts = await bump(`sms:att:${phone}`, limits.codeTtl)
        if (attempts > limits.maxAttempts) {
          await redis.del(codeKey, `sms:att:${phone}`)
          return false
        }
      }
      if (stored === code) {
        await redis.del(codeKey, `sms:att:${phone}`)
        return true
      }
      return false
    },
  }
}
