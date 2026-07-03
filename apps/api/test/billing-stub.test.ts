import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { preDeduct, settle, settleFailed } from "../src/services/billing-stub"
import { grant, getBalance } from "../src/services/credits"
import { seedConfigs } from "../src/services/config"
import { getDb, closeDb } from "../src/db/client"
import { users } from "../src/db/schema"
import { createTestUser, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连真库

let userId = ""

beforeAll(async () => {
  await seedConfigs() // credit_cost.read = 10（占位口径）
  const u = await createTestUser(`+8615${Date.now().toString().slice(-9)}`)
  userId = u.id
})

afterAll(async () => {
  await getDb().delete(users).where(eq(users.id, userId))
  await closeDb()
})

describe("billing-stub → 真账本门面（spec302）", () => {
  it("preDeduct 真扣：余额减少、返回 holdId；settle 结算净消耗", async () => {
    await grant(userId, 30, { idempotencyKey: `g-${userId}` })
    const r = await preDeduct(userId, "read", `ref1-${userId}`)
    expect(r.ok).toBe(true)
    expect(r.hold).toBe(10)
    expect(await getBalance(userId)).toBe(20)
    const cost = await settle(`ref1-${userId}`, r.holdId!, r.hold) // v1 全额结算
    expect(cost).toBe(10)
    expect(await getBalance(userId)).toBe(20) // 净消耗 10
  })

  it("settleFailed 全额退还（净 0）", async () => {
    const r = await preDeduct(userId, "read", `ref2-${userId}`)
    expect(r.ok).toBe(true)
    const before = await getBalance(userId)
    await settleFailed(`ref2-${userId}`, r.holdId!)
    expect(await getBalance(userId)).toBe(before + 10)
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
})
