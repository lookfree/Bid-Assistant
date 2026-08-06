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

/** 验证结果。**必须分得开**：三种失败压成一个 false，前端只能给一句「验证码错误或已过期」，
 *  于是输错一位的用户被告知"已过期"——码明明还在 5 分钟有效期内（2026-08-06 用户反馈）。
 *  expired  没发过码 / 已超时 / 已用过 / 因错太多被作废 —— 唯一该说「已过期」的情形
 *  mismatch 码还在，只是输错了
 *  too_many 错太多次，本次已作废 */
export type SmsVerifyResult = "ok" | "expired" | "mismatch" | "too_many"

export type SmsCodeService = {
  request(input: SmsRequestInput): Promise<SmsRequestResult>
  verify(phone: string, code: string): Promise<SmsVerifyResult>
}

export function makeSmsCodeService(redis: Redis, sender: SmsSender, limits: SmsLimits): SmsCodeService {
  // 固定窗口计数：自增并在首次设过期。返回自增后的值（权威，并发安全）。
  const bump = async (key: string, win: number): Promise<number> => {
    const n = await redis.incr(key)
    if (n === 1) await redis.expire(key, win)
    return n
  }

  // 回滚本次占用的配额与冷却（限频触顶或发送失败时调用，避免误扣用户额度）。
  const rollback = async (keys: string[], cd?: string): Promise<void> => {
    for (const k of keys) await redis.decr(k)
    if (cd) await redis.del(cd)
  }

  return {
    async request({ phone, ip }) {
      const cd = `sms:cd:${phone}`
      // ① 同号冷却（可关）：SET NX 原子占位——占不到说明窗口内已发过，直接拒绝。
      if (limits.cooldownEnabled) {
        const claimed = await redis.set(cd, "1", "EX", limits.cooldown, "NX")
        if (claimed === null) {
          const ttl = await redis.ttl(cd)
          return { ok: false, reason: "cooldown", retryAfter: ttl > 0 ? ttl : limits.cooldown }
        }
      }

      // ②③ 同号 / 同 IP 时·日限频（各自可关）：INCR 先自增、返回值即权威，并发不会都通过。
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
      const bumped: string[] = []
      for (const w of windows) {
        const n = await bump(w.key, w.win)
        bumped.push(w.key)
        if (n > w.cap) {
          await rollback(bumped, limits.cooldownEnabled ? cd : undefined)
          return { ok: false, reason: "rate_limited" }
        }
      }

      // ④ 生成并存码 → 发送；发送失败回滚配额/冷却（发送失败不该扣用户额度）。
      const code = String(randomInt(100000, 1000000))
      await redis.set(`sms:code:${phone}`, code, "EX", limits.codeTtl)
      await redis.del(`sms:att:${phone}`) // 重置尝试计数
      try {
        await sender.send(phone, code)
      } catch (e) {
        await rollback(bumped, limits.cooldownEnabled ? cd : undefined)
        await redis.del(`sms:code:${phone}`)
        throw e
      }
      return { ok: true }
    },

    async verify(phone, code) {
      const codeKey = `sms:code:${phone}`
      const stored = await redis.get(codeKey)
      if (!stored) return "expired"   // 没发过 / 超时 / 已用过 / 已被作废
      // ④ 尝试上限（可关）：超次作废
      if (limits.attemptLimitEnabled) {
        const attempts = await bump(`sms:att:${phone}`, limits.codeTtl)
        if (attempts > limits.maxAttempts) {
          await redis.del(codeKey, `sms:att:${phone}`)
          return "too_many"
        }
      }
      if (stored === code) {
        await redis.del(codeKey, `sms:att:${phone}`)
        return "ok"
      }
      return "mismatch"               // 码还在，只是输错——绝不能报成"已过期"
    },
  }
}
