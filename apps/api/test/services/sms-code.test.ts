import { describe, it, expect, afterAll, setDefaultTimeout } from "bun:test"
import { makeSmsCodeService, type SmsLimits } from "../../src/services/sms-code"
import { getRedis, closeRedis } from "../../src/redis/client"
import type { SmsSender } from "../../src/services/sms-sender"

setDefaultTimeout(20000) // 连远程 Redis

const redis = getRedis()
afterAll(() => closeRedis())

class CapturingSender implements SmsSender {
  last: { phone: string; code: string } | null = null
  async send(phone: string, code: string) {
    this.last = { phone, code }
  }
}

// 默认全关；各测试只开自己要验证的那层
const mk = (o: Partial<SmsLimits> = {}): SmsLimits => ({
  codeTtl: 300,
  cooldownEnabled: false,
  cooldown: 60,
  phoneLimitEnabled: false,
  phoneHour: 5,
  phoneDay: 10,
  ipLimitEnabled: false,
  ipHour: 20,
  ipDay: 50,
  attemptLimitEnabled: false,
  maxAttempts: 5,
  ...o,
})
const newPhone = () => `+8613${(Date.now() + Math.floor(Math.random() * 1e6)).toString().slice(-9)}`

describe("sms-code 防刷", () => {
  it("request -> 6 位码; verify 一次性消费", async () => {
    const sender = new CapturingSender()
    const svc = makeSmsCodeService(redis, sender, mk())
    const phone = newPhone()
    expect((await svc.request({ phone })).ok).toBe(true)
    expect(sender.last?.code).toMatch(/^\d{6}$/)
    expect(await svc.verify(phone, sender.last!.code)).toBe(true)
    expect(await svc.verify(phone, sender.last!.code)).toBe(false) // 已消费
  })

  it("各层默认关闭：立即重发仍 OK（无冷却）", async () => {
    const svc = makeSmsCodeService(redis, new CapturingSender(), mk())
    const phone = newPhone()
    expect((await svc.request({ phone })).ok).toBe(true)
    expect((await svc.request({ phone })).ok).toBe(true) // 冷却关 -> 仍允许
    await redis.del(`sms:code:${phone}`)
  })

  it("开启冷却：立即重发 -> reason cooldown + retryAfter", async () => {
    const svc = makeSmsCodeService(redis, new CapturingSender(), mk({ cooldownEnabled: true }))
    const phone = newPhone()
    await svc.request({ phone })
    const r = await svc.request({ phone })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe("cooldown")
      expect(r.retryAfter).toBeGreaterThan(0)
    }
    await redis.del(`sms:code:${phone}`, `sms:cd:${phone}`)
  })

  it("开启同号限频：触顶 -> rate_limited", async () => {
    const svc = makeSmsCodeService(redis, new CapturingSender(), mk({ phoneLimitEnabled: true, phoneHour: 2 }))
    const phone = newPhone()
    await redis.set(`sms:ph:1h:${phone}`, "2", "EX", 3600) // 预置到上限
    const r = await svc.request({ phone })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("rate_limited")
    await redis.del(`sms:ph:1h:${phone}`)
  })

  it("开启同 IP 限频：触顶 -> rate_limited", async () => {
    const svc = makeSmsCodeService(redis, new CapturingSender(), mk({ ipLimitEnabled: true, ipHour: 2 }))
    const ip = `203.0.113.${Math.floor(Math.random() * 255)}`
    await redis.set(`sms:ip:1h:${ip}`, "2", "EX", 3600)
    const r = await svc.request({ phone: newPhone(), ip })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("rate_limited")
    await redis.del(`sms:ip:1h:${ip}`)
  })

  it("开启尝试上限：超次后验证码作废", async () => {
    const sender = new CapturingSender()
    const svc = makeSmsCodeService(redis, sender, mk({ attemptLimitEnabled: true, maxAttempts: 2 }))
    const phone = newPhone()
    await svc.request({ phone })
    const correct = sender.last!.code
    expect(await svc.verify(phone, "000000")).toBe(false) // 第 1 次
    expect(await svc.verify(phone, "000000")).toBe(false) // 第 2 次
    expect(await svc.verify(phone, correct)).toBe(false) // 第 3 次 > 2 -> 作废
  })
})
