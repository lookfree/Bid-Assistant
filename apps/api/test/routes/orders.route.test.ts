import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { ordersRoutes } from "../../src/routes/orders"
import { loginWithPhone } from "../../src/services/auth"
import { getDb, closeDb } from "../../src/db/client"
import { users, paymentOrders } from "../../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "../repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/routes/orders.route.test.ts）

const app = new Hono()
app.route("/api/orders", ordersRoutes())
let token = ""
let userId = ""

beforeAll(async () => {
  const a = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  token = a.token
  userId = a.user.id
  const base = Date.now()
  await getDb()
    .insert(paymentOrders)
    .values(
      Array.from({ length: 22 }, (_, i) => ({
        userId,
        type: "recharge" as const,
        amountCents: 3900 + i * 100,
        status: "paid" as const,
        clientSn: `t-${randomUUID()}`,
        idempotencyKey: `ordroute:${userId}:${i}:${randomUUID()}`,
        createdAt: new Date(base - (22 - i) * 1000),
      })),
    )
})
afterAll(async () => {
  await getDb().delete(users).where(eq(users.id, userId))
  await closeDb()
})

const auth = () => ({ Authorization: `Bearer ${token}` })

describe("spec308 GET /api/orders", () => {
  it("首页 200：items 20 / total 22 / hasMore true / 金额换算", async () => {
    const res = await app.request("/api/orders?page=1&pageSize=20", { headers: auth() })
    expect(res.status).toBe(200)
    const b = (await res.json()) as any
    expect(b.items.length).toBe(20)
    expect(b.total).toBe(22)
    expect(b.hasMore).toBe(true)
    expect(b.items[0].amountYuan).toBe(b.items[0].amountCents / 100)
  })

  it("第二页 hasMore false（剩 2 条）", async () => {
    const b = (await (await app.request("/api/orders?page=2&pageSize=20", { headers: auth() })).json()) as any
    expect(b.items.length).toBe(2)
    expect(b.hasMore).toBe(false)
  })

  it("page 非法 400", async () => {
    expect((await app.request("/api/orders?page=-1", { headers: auth() })).status).toBe(400)
  })

  it("未登录 401", async () => {
    expect((await app.request("/api/orders")).status).toBe(401)
  })
})
