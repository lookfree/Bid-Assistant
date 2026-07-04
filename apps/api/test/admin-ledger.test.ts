import { describe, it, expect, afterAll, setDefaultTimeout } from "bun:test"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { listLedger, checkBalance } from "../src/services/admin/ledger"
import { getDb, closeDb } from "../src/db/client"
import { users, creditTransactions, creditBalances } from "../src/db/schema"
import { makeUserWithNickname, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/admin-ledger.test.ts）

const madeUsers: string[] = []
const regU = (id: string) => madeUsers.push(id)

afterAll(async () => {
  for (const id of madeUsers) await getDb().delete(users).where(eq(users.id, id))
  await closeDb()
})

describe("spec310 账本页", () => {
  it("按用户查流水 + type 过滤 + 分页", async () => {
    const u = await makeUserWithNickname(regU)
    await getDb().insert(creditTransactions).values({ userId: u, type: "grant", amount: 100, idempotencyKey: `l-${randomUUID()}` })
    await getDb().insert(creditTransactions).values({ userId: u, type: "hold", amount: -10, idempotencyKey: `l-${randomUUID()}` })
    const all = await listLedger({ userId: u, page: 1, pageSize: 50 })
    expect(all.total).toBe(2)
    const onlyHold = await listLedger({ userId: u, type: "hold", page: 1, pageSize: 50 })
    expect(onlyHold.items.every((t) => t.type === "hold")).toBe(true)
  })

  it("余额核对：缓存 vs Σ流水（一致/不一致）", async () => {
    const u = await makeUserWithNickname(regU)
    await getDb().insert(creditTransactions).values({ userId: u, type: "grant", amount: 100, idempotencyKey: `l-${randomUUID()}` })
    await getDb().insert(creditBalances).values({ userId: u, balance: 100 })
    expect(await checkBalance(u)).toEqual({ userId: u, cached: 100, actual: 100, consistent: true })
    await getDb().update(creditBalances).set({ balance: 80 }).where(eq(creditBalances.userId, u))
    const bad = await checkBalance(u)
    expect(bad.consistent).toBe(false)
    expect(bad.actual).toBe(100)
  })
})
