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
// 注册即赠积分（auth.grantSignupBonus）在新用户账本里先有一条 signup 流水——生产里每个用户都如此，
// 不存在「空账本的注册用户」。分页断言一律基于 SEEDED + 这条基线，不去删它、也不写死赠送额度。
let baseline = 0
const SEEDED = 25

beforeAll(async () => {
  const a = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => "ok" as const)
  token = a.token
  userId = a.user.id
  baseline = (await getDb().select().from(creditTransactions).where(eq(creditTransactions.userId, userId))).length
  const base = Date.now()
  await getDb()
    .insert(creditTransactions)
    .values(
      Array.from({ length: SEEDED }, (_, i) => ({
        userId,
        type: "grant" as const,
        amount: 100 + i,
        idempotencyKey: `route:${userId}:${i}:${randomUUID()}`,
        createdAt: new Date(base - (SEEDED - i) * 1000),
      })),
    )
})
afterAll(async () => {
  await getDb().delete(users).where(eq(users.id, userId))
  await closeDb()
})

const auth = () => ({ Authorization: `Bearer ${token}` })

describe("spec308 GET /api/credits/transactions", () => {
  it("首页 200：满页 20 条 / total = 基线 + 播种 / hasMore true", async () => {
    const res = await app.request("/api/credits/transactions?page=1&pageSize=20", { headers: auth() })
    expect(res.status).toBe(200)
    const b = (await res.json()) as any
    expect(b.items.length).toBe(20)
    expect(b.page).toBe(1)
    expect(b.pageSize).toBe(20)
    expect(b.total).toBe(baseline + SEEDED)
    expect(b.hasMore).toBe(true)
  })

  it("第二页收尾：剩余条数正确且 hasMore false", async () => {
    const b = (await (await app.request("/api/credits/transactions?page=2&pageSize=20", { headers: auth() })).json()) as any
    expect(b.items.length).toBe(baseline + SEEDED - 20)
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
