import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { preDeduct, settle, settleFailed, settleContent, holdOpForStep } from "../src/services/billing-stub"
import { grant, getBalance } from "../src/services/credits"
import { seedConfigs, setConfig } from "../src/services/config"
import { getDb, closeDb } from "../src/db/client"
import { users } from "../src/db/schema"
import { createTestUser, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连真库

let userId = ""

beforeAll(async () => {
  await seedConfigs()
  // seedConfigs 不覆盖已存在键，旧环境值不会被刷成新默认；本套断言依赖的口径显式钉死，与环境/文件顺序解耦。
  await setConfig("credit_cost.read", 20)
  await setConfig("credit_cost.content_short", 40)
  await setConfig("credit_cost.content_long", 80)
  const u = await createTestUser(`+8615${Date.now().toString().slice(-9)}`)
  userId = u.id
})

afterAll(async () => {
  await getDb().delete(users).where(eq(users.id, userId))
  await closeDb()
})

describe("billing-stub → 真账本门面（spec302）", () => {
  it("preDeduct 真扣：余额减少、返回 holdId；settle 结算净消耗", async () => {
    await grant(userId, 60, { idempotencyKey: `g-${userId}` }) // 一次性授信，覆盖本 describe 后续各步 hold
    const r = await preDeduct(userId, "read", `ref1-${userId}`)
    expect(r.ok).toBe(true)
    expect(r.hold).toBe(20) // credit_cost.read 真实配置默认值
    expect(await getBalance(userId)).toBe(40)
    const cost = await settle(`ref1-${userId}`, r.holdId!, r.hold) // 非 content 步全额结算
    expect(cost).toBe(20)
    expect(await getBalance(userId)).toBe(40) // 净消耗 20
  })

  it("settleFailed 全额退还（净 0）", async () => {
    const r = await preDeduct(userId, "read", `ref2-${userId}`)
    expect(r.ok).toBe(true)
    const before = await getBalance(userId)
    await settleFailed(`ref2-${userId}`, r.holdId!)
    expect(await getBalance(userId)).toBe(before + 20)
  })

  it("余额不足 → ok:false，不产生扣减", async () => {
    const poor = await createTestUser(`+8616${Date.now().toString().slice(-9)}`)
    try {
      const r = await preDeduct(poor.id, "read", `ref3-${poor.id}`)
      expect(r).toEqual({ ok: false, hold: 0 })
      expect(await getBalance(poor.id)).toBe(0)
    } finally {
      await getDb().delete(users).where(eq(users.id, poor.id))
    }
  })

  it("content 步按篇幅分档：预扣上档 content_long(80)，短篇结算 content_short(40)、长篇足额(80)", async () => {
    expect(holdOpForStep("content")).toBe("content_long") // 预扣按上档，防结算少补扣穿
    expect(holdOpForStep("read")).toBe("read") // 其余步用同名真实配置键
    await grant(userId, 200, { idempotencyKey: `gc-${userId}` })

    // 短篇：任一章 ≤ 2000 字 → 结算落 content_short(40)，退差额 40
    const rS = await preDeduct(userId, holdOpForStep("content"), `refc1-${userId}`)
    expect(rS.hold).toBe(80)
    const costS = await settleContent(`refc1-${userId}`, rS.holdId!, rS.hold, 1500)
    expect(costS).toBe(40)

    // 长篇：某章 > 2000 字 → 足额结算 content_long(80)，不退
    const rL = await preDeduct(userId, holdOpForStep("content"), `refc2-${userId}`)
    const costL = await settleContent(`refc2-${userId}`, rL.holdId!, rL.hold, 3000)
    expect(costL).toBe(80)
  })
})
