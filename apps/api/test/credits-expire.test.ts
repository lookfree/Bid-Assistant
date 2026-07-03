import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { getDb, closeDb } from "../src/db/client"
import { users } from "../src/db/schema"
import { grant, hold, settle, getBalance, expireDue } from "../src/services/credits"
import { seedConfigs } from "../src/services/config"
import { makeLedgerUser, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS)

const madeUsers: string[] = []
const makeUser = () => makeLedgerUser((id) => madeUsers.push(id))

beforeAll(async () => {
  await seedConfigs()
})

afterAll(async () => {
  for (const id of madeUsers) await getDb().delete(users).where(eq(users.id, id))
  await closeDb()
})

const past = () => new Date(Date.now() - 86400_000) // 昨天
const future = () => new Date(Date.now() + 86400_000)

describe("spec302 FIFO 过期", () => {
  it("先过期批次的未消耗部分被注销；重复跑幂等", async () => {
    const userId = await makeUser()
    await grant(userId, 50, { idempotencyKey: `early-${userId}`, expireAt: past() })
    await grant(userId, 50, { idempotencyKey: `late-${userId}`, expireAt: future() })
    expect(await getBalance(userId)).toBe(100)
    const expired = await expireDue(new Date())
    expect(expired).toBe(50) // 早批次全过期
    expect(await getBalance(userId)).toBe(50)
    const again = await expireDue(new Date()) // 幂等：同批次不重复过期
    expect(again).toBe(0)
    expect(await getBalance(userId)).toBe(50)
  })

  it("FIFO：已落地消耗从最早到期批次抵扣，晚批次承担过期", async () => {
    // 早批 50（已过期）+ 晚批 50；已落地消耗 30 → 早批剩 20 过期，余额 = 50
    const userId = await makeUser()
    await grant(userId, 50, { idempotencyKey: `early-${userId}`, expireAt: past() })
    await grant(userId, 50, { idempotencyKey: `late-${userId}`, expireAt: future() })
    const { holdId } = await hold(userId, "read", { ref: `r1-${userId}`, idempotencyKey: `h1-${userId}` })
    await settle(holdId, 10, { idempotencyKey: `s1-${userId}` }) // 落地消耗 10
    const { holdId: h2 } = await hold(userId, "read", { ref: `r2-${userId}`, idempotencyKey: `h2-${userId}` })
    await settle(h2, 20, { idempotencyKey: `s2-${userId}` }) // 落地消耗 20（累计 30）
    expect(await getBalance(userId)).toBe(70)
    const expired = await expireDue(new Date())
    expect(expired).toBe(20) // 早批 50 - 消耗 30 = 剩 20 过期
    expect(await getBalance(userId)).toBe(50) // 晚批完整保留
  })

  it("在途 hold 不计入消耗：过期不被高估（漏过期回归）", async () => {
    // BUG 行为：把在途 hold(-10) 当消耗 → 误以为早批已消耗 10 → 只过期 40
    // 正确行为：在途 hold 不算消耗 → 早批全额过期 50
    const userId = await makeUser()
    await grant(userId, 50, { idempotencyKey: `early-${userId}`, expireAt: past() })
    await grant(userId, 50, { idempotencyKey: `late-${userId}`, expireAt: future() })
    await hold(userId, "read", { ref: `r-${userId}`, idempotencyKey: `h-${userId}` }) // 在途，未 settle/release
    const expired = await expireDue(new Date())
    expect(expired).toBe(50)
    expect(await getBalance(userId)).toBe(40) // 100 - hold 10 - expire 50
  })

  it("无到期批次时 expireDue 为 0；不带 expire_at 的入账永不过期", async () => {
    const userId = await makeUser()
    await grant(userId, 30, { idempotencyKey: `g-${userId}` }) // 无 expireAt
    expect(await expireDue(new Date())).toBe(0)
    expect(await getBalance(userId)).toBe(30)
  })
})
