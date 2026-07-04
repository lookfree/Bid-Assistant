import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { randomUUID } from "node:crypto"
import { eq, inArray } from "drizzle-orm"
import { Hono } from "hono"
import { membershipRoutes } from "../../src/routes/membership"
import { creditsRoutes } from "../../src/routes/credits"
import { ordersRoutes } from "../../src/routes/orders"
import { loginWithPhone } from "../../src/services/auth"
import { seedConfigs } from "../../src/services/config"
import { getDb, closeDb } from "../../src/db/client"
import { users, plans, subscriptions, creditTransactions, paymentOrders } from "../../src/db/schema"
import { makeTestPlan, uniquePhone, TEST_TIMEOUT_MS } from "../repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/integration/membership-e2e.test.ts）

// 会员中心三接口在同一 app 上串联（回归：路由挂载 + 鉴权保护）
const app = new Hono()
app.route("/api/membership", membershipRoutes())
app.route("/api/credits", creditsRoutes())
app.route("/api/orders", ordersRoutes())

const madePlans: string[] = []
let token = ""
let userId = ""
let personalId = ""

beforeAll(async () => {
  await seedConfigs()
  const a = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  token = a.token
  userId = a.user.id
  await makeTestPlan((id) => madePlans.push(id), { name: "免费版", code: "free", priceCents: 0 })
  personalId = await makeTestPlan((id) => madePlans.push(id), { name: "个人版", code: "personal", priceCents: 3900, grantCreditsPerCycle: 1200 })
  await makeTestPlan((id) => madePlans.push(id), { name: "专业版", code: "professional", priceCents: 15900, grantCreditsPerCycle: 6000 })
  await getDb()
    .insert(subscriptions)
    .values({ userId, planId: personalId, status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) })
  await getDb()
    .insert(creditTransactions)
    .values(Array.from({ length: 3 }, (_, i) => ({ userId, type: "grant" as const, amount: 100 + i, idempotencyKey: `e2e:${userId}:${i}:${randomUUID()}` })))
  await getDb()
    .insert(paymentOrders)
    .values(Array.from({ length: 2 }, (_, i) => ({ userId, type: "renewal" as const, amountCents: 3900, status: "paid" as const, planId: personalId, clientSn: `t-${randomUUID()}`, idempotencyKey: `e2e-ord:${userId}:${i}:${randomUUID()}` })))
})
afterAll(async () => {
  await getDb().delete(users).where(eq(users.id, userId)) // 级联删订阅/流水/订单
  await getDb().delete(plans).where(inArray(plans.id, madePlans))
  await closeDb()
})

const auth = () => ({ Authorization: `Bearer ${token}` })

describe("spec308 会员中心端到端", () => {
  it("聚合：personal active + 余额 + 三档 + progressive.next=professional", async () => {
    const b = (await (await app.request("/api/membership", { headers: auth() })).json()) as any
    expect(b.subscription.tierId).toBe("personal")
    expect(b.subscription.status).toBe("active")
    expect(typeof b.balance).toBe("number")
    expect(b.plans.length).toBe(3)
    expect(b.progressive.current.tierId).toBe("personal")
    expect(b.progressive.next.tierId).toBe("professional")
  })

  it("流水分页正确", async () => {
    const b = (await (await app.request("/api/credits/transactions?page=1&pageSize=20", { headers: auth() })).json()) as any
    expect(b.total).toBe(3)
    expect(b.hasMore).toBe(false)
  })

  it("订单分页正确", async () => {
    const b = (await (await app.request("/api/orders?page=1&pageSize=20", { headers: auth() })).json()) as any
    expect(b.total).toBe(2)
    expect(b.items.length).toBe(2)
  })

  it("三接口未登录全部 401", async () => {
    expect((await app.request("/api/membership")).status).toBe(401)
    expect((await app.request("/api/credits/transactions")).status).toBe(401)
    expect((await app.request("/api/orders")).status).toBe(401)
  })
})
