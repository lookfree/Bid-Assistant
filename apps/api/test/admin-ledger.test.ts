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

  it("不传 userId = 全部用户视图：跨用户都能看到，且每行带用户展示名", async () => {
    // 运营的用法是「先看全局有没有异常流水，再点进具体的人」；先选人才能看，等于要求他预先知道找谁。
    // 断言只看自己造的两个用户（这张表是共享库，用全局计数会被别的用例污染成偶发失败）。
    const a = await makeUserWithNickname(regU)
    const b = await makeUserWithNickname(regU)
    const keyA = `l-all-a-${randomUUID()}`
    const keyB = `l-all-b-${randomUUID()}`
    await getDb().insert(creditTransactions).values({ userId: a, type: "grant", amount: 111, idempotencyKey: keyA })
    await getDb().insert(creditTransactions).values({ userId: b, type: "grant", amount: 222, idempotencyKey: keyB })

    const page = await listLedger({ page: 1, pageSize: 200 })
    const mine = page.items.filter((t) => t.idempotencyKey === keyA || t.idempotencyKey === keyB)
    expect(mine).toHaveLength(2)                                  // 两个用户的流水都在同一页里
    expect(mine.every((t) => !!t.userName)).toBe(true)            // 每行看得出是谁的
    expect(new Set(mine.map((t) => t.userName)).size).toBe(2)     // 不同用户显示不同名字
  })

  it("全部用户视图仍可按 type 过滤", async () => {
    const u = await makeUserWithNickname(regU)
    const key = `l-all-t-${randomUUID()}`
    await getDb().insert(creditTransactions).values({ userId: u, type: "hold", amount: -5, idempotencyKey: key })
    const held = await listLedger({ type: "hold", page: 1, pageSize: 200 })
    expect(held.items.every((t) => t.type === "hold")).toBe(true)
    expect(held.items.some((t) => t.idempotencyKey === key)).toBe(true)
  })

  it("单用户视图同样带展示名（与选择器同一口径，免得同一个人两处显示不一样）", async () => {
    const u = await makeUserWithNickname(regU)
    await getDb().insert(creditTransactions).values({ userId: u, type: "grant", amount: 7, idempotencyKey: `l-n-${randomUUID()}` })
    const r = await listLedger({ userId: u, page: 1, pageSize: 10 })
    expect(r.items[0]!.userName).toBeTruthy()
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
