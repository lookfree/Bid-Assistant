import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { getDb, closeDb } from "../../src/db/client"
import { users, paymentOrders } from "../../src/db/schema"
import { listOrders } from "../../src/services/order-history"
import { makeLedgerUser, TEST_TIMEOUT_MS } from "../repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/services/order-history.test.ts）

const madeUsers: string[] = []
let userId = ""
let otherId = ""
const TYPES = ["recharge", "renewal", "purchase"] as const
const STATUS = ["created", "paid", "failed", "refunded"] as const

async function seedOrders(uid: string, count: number) {
  const base = Date.now()
  const rows = Array.from({ length: count }, (_, i) => ({
    userId: uid,
    type: TYPES[i % TYPES.length]!,
    amountCents: 3900 + i * 100,
    status: STATUS[i % STATUS.length]!,
    clientSn: `t-${randomUUID()}`,
    idempotencyKey: `ord:${uid}:${i}:${randomUUID()}`,
    createdAt: new Date(base - (count - i) * 1000),
  }))
  await getDb().insert(paymentOrders).values(rows)
}

beforeAll(async () => {
  userId = await makeLedgerUser((id) => madeUsers.push(id))
  otherId = await makeLedgerUser((id) => madeUsers.push(id))
  await seedOrders(userId, 22)
  await seedOrders(otherId, 4)
})
afterAll(async () => {
  for (const id of madeUsers) await getDb().delete(users).where(eq(users.id, id)) // 级联删订单
  await closeDb()
})

describe("spec308 我的订单分页", () => {
  it("首页 20 条，total=22，createdAt desc", async () => {
    const { items, total } = await listOrders(userId, { page: 1, pageSize: 20, offset: 0 })
    expect(items.length).toBe(20)
    expect(total).toBe(22)
    for (let i = 1; i < items.length; i++) {
      expect(items[i - 1]!.createdAt >= items[i]!.createdAt).toBe(true)
    }
  })

  it("第二页剩 2 条", async () => {
    const { items } = await listOrders(userId, { page: 2, pageSize: 20, offset: 20 })
    expect(items.length).toBe(2)
  })

  it("金额换算一致 amountCents→amountYuan", async () => {
    const { items } = await listOrders(userId, { page: 1, pageSize: 1, offset: 0 })
    expect(items[0]!.amountYuan).toBe(items[0]!.amountCents / 100)
  })

  it("用户隔离：total 不含他人订单", async () => {
    const { total } = await listOrders(userId, { page: 1, pageSize: 20, offset: 0 })
    expect(total).toBe(22)
  })
})
