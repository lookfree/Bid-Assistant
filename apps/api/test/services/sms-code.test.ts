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
    expect(await svc.verify(phone, sender.last!.code)).toBe("ok")
    expect(await svc.verify(phone, sender.last!.code)).toBe("expired") // 已消费
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
    expect(await svc.verify(phone, "000000")).toBe("mismatch") // 第 1 次：码还在，只是输错
    expect(await svc.verify(phone, "000000")).toBe("mismatch") // 第 2 次
    expect(await svc.verify(phone, correct)).toBe("too_many") // 第 3 次 > 2 -> 作废
  })
})

// 2026-08-06 用户反馈：「验证码还在 5 分钟有效期内，显示过期」。
// 原因是 verify 把三种情况压成同一个 false，前端一句「验证码错误或已过期」全包——
// 用户输错一位，看到的却是"已过期"，于是认定系统在骗人。过期就说过期，没过期要说真实原因。
describe("验证失败的三种原因必须分得开", () => {
  const phone = () => `+8613${Math.floor(Math.random() * 1e9).toString().padStart(9, "0")}`

  it("码正确 → ok", async () => {
    const s = new CapturingSender()
    const svc = makeSmsCodeService(redis, s, mk())
    const p = phone()
    await svc.request({ phone: p })
    expect(await svc.verify(p, s.last!.code)).toBe("ok")
  })

  it("没发过码 / 码已过期 → expired（唯一该说「已过期」的情形）", async () => {
    const svc = makeSmsCodeService(redis, new CapturingSender(), mk())
    expect(await svc.verify(phone(), "123456")).toBe("expired")
  })

  it("码还在有效期内、只是输错 → mismatch，不能报成过期", async () => {
    const s = new CapturingSender()
    const svc = makeSmsCodeService(redis, s, mk())
    const p = phone()
    await svc.request({ phone: p })
    const wrong = s.last!.code === "000000" ? "111111" : "000000"
    expect(await svc.verify(p, wrong)).toBe("mismatch")
    // 输错不作废：用户还能再试（尝试上限关闭时）
    expect(await svc.verify(p, s.last!.code)).toBe("ok")
  })

  it("错太多次 → too_many，并作废该码", async () => {
    const s = new CapturingSender()
    const svc = makeSmsCodeService(redis, s, mk({ attemptLimitEnabled: true, maxAttempts: 2 }))
    const p = phone()
    await svc.request({ phone: p })
    expect(await svc.verify(p, "000000")).toBe("mismatch")
    expect(await svc.verify(p, "000000")).toBe("mismatch")
    expect(await svc.verify(p, "000000")).toBe("too_many")
    // 作废之后，连正确的码也不再认——但要报"已过期"而不是"输错"
    expect(await svc.verify(p, s.last!.code)).toBe("expired")
  })

  it("验证成功后码即作废（防重放）", async () => {
    const s = new CapturingSender()
    const svc = makeSmsCodeService(redis, s, mk())
    const p = phone()
    await svc.request({ phone: p })
    const code = s.last!.code
    expect(await svc.verify(p, code)).toBe("ok")
    expect(await svc.verify(p, code)).toBe("expired")
  })
})
