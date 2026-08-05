import { describe, it, expect, afterAll, setDefaultTimeout } from "bun:test"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { listCreditTransactions } from "../src/services/credits-history"
import { getDb, closeDb } from "../src/db/client"
import { users, creditTransactions } from "../src/db/schema"
import { makeUserWithNickname, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS)

const made: string[] = []
afterAll(async () => {
  for (const id of made) await getDb().delete(users).where(eq(users.id, id))
  await closeDb()
})

const tx = (userId: string, type: string, amount: number) => ({
  userId, type, amount, idempotencyKey: `ch-${randomUUID()}`,
})

// 积分是预扣制：开跑前 hold(-N)，跑完写 settle(预扣 − 实际用量)。计费按档位定死，
// 实际用量通常正好等于预扣 → 差额为 0（230 实测 190 条结算里 181 条为 0）。
// 这些行余额一分没动，对用户是噪音；更要命的是每页 10 条会被滤到只剩一两行，
// 所以必须在 SQL 层滤掉，让 total 与页大小都对得上。
describe("C 端积分流水：只回余额真的动了的行", () => {
  it("金额为 0 的结算不出现在列表里，也不计入 total", async () => {
    const u = await makeUserWithNickname((id) => made.push(id))
    await getDb().insert(creditTransactions).values([
      tx(u, "hold", -100),
      tx(u, "settle", 0), // 用量与预扣一致
      tx(u, "grant", 200),
    ])
    const r = await listCreditTransactions(u, { page: 1, pageSize: 20, offset: 0 })
    expect(r.total).toBe(2)
    expect(r.items.map((i) => i.amount).sort((a, b) => a - b)).toEqual([-100, 200])
    expect(r.items.some((i) => i.amount === 0)).toBe(false)
  })

  it("差额非零的结算必须留着——那是真退回用户的积分", async () => {
    const u = await makeUserWithNickname((id) => made.push(id))
    await getDb().insert(creditTransactions).values([tx(u, "hold", -200), tx(u, "settle", 180)])
    const r = await listCreditTransactions(u, { page: 1, pageSize: 20, offset: 0 })
    expect(r.total).toBe(2)
    expect(r.items.some((i) => i.type === "settle" && i.amount === 180)).toBe(true)
  })

  it("分页按过滤后的行数走：每页 10 条就该给满 10 条，不能被 0 值行挖空", async () => {
    const u = await makeUserWithNickname((id) => made.push(id))
    const rows = []
    for (let i = 0; i < 12; i++) {
      rows.push(tx(u, "hold", -10))
      rows.push(tx(u, "settle", 0)) // 每笔都配一条 0 值结算（真实形态）
    }
    await getDb().insert(creditTransactions).values(rows)

    const p1 = await listCreditTransactions(u, { page: 1, pageSize: 10, offset: 0 })
    expect(p1.total).toBe(12) // 24 条里只有 12 条余额动过
    expect(p1.items).toHaveLength(10)
    const p2 = await listCreditTransactions(u, { page: 2, pageSize: 10, offset: 10 })
    expect(p2.items).toHaveLength(2)
    // 两页不重叠（分页在 SQL 层做，不会因为客户端过滤而错位）
    const ids = new Set([...p1.items, ...p2.items].map((i) => i.id))
    expect(ids.size).toBe(12)
  })

  it("只看自己的流水", async () => {
    const a = await makeUserWithNickname((id) => made.push(id))
    const b = await makeUserWithNickname((id) => made.push(id))
    await getDb().insert(creditTransactions).values([tx(a, "grant", 10), tx(b, "grant", 20)])
    const r = await listCreditTransactions(a, { page: 1, pageSize: 20, offset: 0 })
    expect(r.total).toBe(1)
    expect(r.items[0]!.amount).toBe(10)
  })
})
