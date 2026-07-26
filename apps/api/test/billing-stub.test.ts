import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { preDeduct, settle, settleFailed, settleContent, resolveStepHoldAmount } from "../src/services/billing-stub"
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

  it("content 步按产出总字数分档：预扣阶梯最大价，落档后多退", async () => {
    await setConfig("credit_cost.content_tiers", [
      { maxChars: 50_000, cost: 40 },
      { maxChars: 150_000, cost: 80 },
      { maxChars: null, cost: 260 },
    ])
    expect(await resolveStepHoldAmount("content")).toBe(260) // 预扣取最大价，防结算少补扣穿
    expect(await resolveStepHoldAmount("read")).toBeUndefined() // 其余步按 credit_cost.<step>
    await grant(userId, 600, { idempotencyKey: `gc-${userId}` })

    // 低档：总字数 3 万 → 结算 40，退 220
    const rS = await preDeduct(userId, "content", `refc1-${userId}`, 260)
    expect(rS.hold).toBe(260)
    expect(await settleContent(`refc1-${userId}`, rS.holdId!, rS.hold, 30_000)).toBe(40)

    // 顶档：总字数 40 万 → 足额 260
    const rL = await preDeduct(userId, "content", `refc2-${userId}`, 260)
    expect(await settleContent(`refc2-${userId}`, rL.holdId!, rL.hold, 400_000)).toBe(260)

    // 兼容：预扣额小于落档价（发版时的在途 run）→ 钳到预扣额，不扣穿
    const rOld = await preDeduct(userId, "content", `refc3-${userId}`, 80)
    expect(await settleContent(`refc3-${userId}`, rOld.holdId!, rOld.hold, 400_000)).toBe(80)
  })
})
