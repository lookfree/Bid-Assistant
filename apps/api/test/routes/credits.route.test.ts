import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { creditsRoutes } from "../../src/routes/credits"
import { loginWithPhone } from "../../src/services/auth"
import { getDb, closeDb } from "../../src/db/client"
import { users, creditTransactions } from "../../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "../repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/routes/credits.route.test.ts）

const app = new Hono()
app.route("/api/credits", creditsRoutes())
let token = ""
let userId = ""

beforeAll(async () => {
  const a = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  token = a.token
  userId = a.user.id
  const base = Date.now()
  await getDb()
    .insert(creditTransactions)
    .values(
      Array.from({ length: 25 }, (_, i) => ({
        userId,
        type: "grant" as const,
        amount: 100 + i,
        idempotencyKey: `route:${userId}:${i}:${randomUUID()}`,
        createdAt: new Date(base - (25 - i) * 1000),
      })),
    )
})
afterAll(async () => {
  await getDb().delete(users).where(eq(users.id, userId))
  await closeDb()
})

const auth = () => ({ Authorization: `Bearer ${token}` })

describe("spec308 GET /api/credits/transactions", () => {
  it("首页 200：items 20 / total 25 / hasMore true", async () => {
    const res = await app.request("/api/credits/transactions?page=1&pageSize=20", { headers: auth() })
    expect(res.status).toBe(200)
    const b = (await res.json()) as any
    expect(b.items.length).toBe(20)
    expect(b.page).toBe(1)
    expect(b.pageSize).toBe(20)
    expect(b.total).toBe(25)
    expect(b.hasMore).toBe(true)
  })

  it("第二页 hasMore false", async () => {
    const b = (await (await app.request("/api/credits/transactions?page=2&pageSize=20", { headers: auth() })).json()) as any
    expect(b.items.length).toBe(5)
    expect(b.hasMore).toBe(false)
  })

  it("pageSize 超限截到 100", async () => {
    const b = (await (await app.request("/api/credits/transactions?pageSize=999", { headers: auth() })).json()) as any
    expect(b.pageSize).toBe(100)
  })

  it("page 非法 400", async () => {
    expect((await app.request("/api/credits/transactions?page=abc", { headers: auth() })).status).toBe(400)
  })

  it("未登录 401", async () => {
    expect((await app.request("/api/credits/transactions")).status).toBe(401)
  })
})
