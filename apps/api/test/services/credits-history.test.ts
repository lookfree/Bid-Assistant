import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { getDb, closeDb } from "../../src/db/client"
import { users, creditTransactions } from "../../src/db/schema"
import { listCreditTransactions } from "../../src/services/credits-history"
import { makeLedgerUser, TEST_TIMEOUT_MS } from "../repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/services/credits-history.test.ts）

const madeUsers: string[] = []
let userId = ""
let otherId = ""
const TYPES = ["grant", "purchase", "expire", "referral_reward"] as const

async function seedTx(uid: string, count: number) {
  const base = Date.now()
  const rows = Array.from({ length: count }, (_, i) => ({
    userId: uid,
    type: TYPES[i % TYPES.length]!,
    amount: i % 2 === 0 ? 100 + i : -(50 + i), // 带符号
    ref: i % 3 === 0 ? `order:${i}` : null,
    expireAt: i % 4 === 0 ? new Date(base + 86_400_000) : null,
    idempotencyKey: `hist:${uid}:${i}:${randomUUID()}`,
    createdAt: new Date(base - (count - i) * 1000), // i 越大越新
  }))
  await getDb().insert(creditTransactions).values(rows)
}

beforeAll(async () => {
  userId = await makeLedgerUser((id) => madeUsers.push(id))
  otherId = await makeLedgerUser((id) => madeUsers.push(id))
  await seedTx(userId, 25)
  await seedTx(otherId, 3) // 隔离对照
})
afterAll(async () => {
  for (const id of madeUsers) await getDb().delete(users).where(eq(users.id, id)) // 级联删流水
  await closeDb()
})

describe("spec308 积分流水分页", () => {
  it("首页 20 条，total=25，createdAt desc", async () => {
    const { items, total } = await listCreditTransactions(userId, { page: 1, pageSize: 20, offset: 0 })
    expect(items.length).toBe(20)
    expect(total).toBe(25)
    for (let i = 1; i < items.length; i++) {
      expect(items[i - 1]!.createdAt >= items[i]!.createdAt).toBe(true)
    }
  })

  it("第二页 offset 20 → 剩 5 条", async () => {
    const { items } = await listCreditTransactions(userId, { page: 2, pageSize: 20, offset: 20 })
    expect(items.length).toBe(5)
  })

  it("用户隔离：只返回该用户流水（total 不含他人）", async () => {
    const { total } = await listCreditTransactions(userId, { page: 1, pageSize: 20, offset: 0 })
    expect(total).toBe(25) // otherId 的 3 条不计入
  })

  it("字段映射：type/amount 带符号/ref/expireAt ISO 或 null/createdAt ISO", async () => {
    const { items } = await listCreditTransactions(userId, { page: 1, pageSize: 100, offset: 0 })
    const withExpire = items.find((x) => x.expireAt != null)!
    expect(typeof withExpire.expireAt).toBe("string")
    expect(items.some((x) => x.amount < 0)).toBe(true)
    expect(typeof items[0]!.createdAt).toBe("string")
  })
})
