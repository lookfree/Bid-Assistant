import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import { Hono } from "hono"
import { membershipRoutes } from "../../src/routes/membership"
import { loginWithPhone } from "../../src/services/auth"
import { seedConfigs } from "../../src/services/config"
import { getDb, closeDb } from "../../src/db/client"
import { users, plans } from "../../src/db/schema"
import { makeTestPlan, uniquePhone, TEST_TIMEOUT_MS } from "../repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/routes/membership.route.test.ts）

const app = new Hono()
app.route("/api/membership", membershipRoutes()) // GET / 只读，不依赖支付凭据
const madePlans: string[] = []
let token = ""
let userId = ""

beforeAll(async () => {
  await seedConfigs()
  const a = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  token = a.token
  userId = a.user.id
  await makeTestPlan((id) => madePlans.push(id), { name: "免费版", code: "free", priceCents: 0 })
  await makeTestPlan((id) => madePlans.push(id), { name: "个人版", code: "personal", priceCents: 3900, grantCreditsPerCycle: 1200 })
  await makeTestPlan((id) => madePlans.push(id), { name: "专业版", code: "professional", priceCents: 15900, grantCreditsPerCycle: 6000 })
})
afterAll(async () => {
  await getDb().delete(users).where(eq(users.id, userId))
  await getDb().delete(plans).where(inArray(plans.id, madePlans))
  await closeDb()
})

const auth = () => ({ Authorization: `Bearer ${token}` })

describe("spec308 GET /api/membership", () => {
  it("未登录 401", async () => {
    expect((await app.request("/api/membership")).status).toBe(401)
  })

  it("带 token 200，camelCase，含 subscription/balance/plans/progressive", async () => {
    const res = await app.request("/api/membership", { headers: auth() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body).toHaveProperty("subscription")
    expect(body).toHaveProperty("balance")
    expect(Array.isArray(body.plans)).toBe(true)
    expect(body.plans.length).toBe(3)
    expect(body.plans[0]).toHaveProperty("tierId") // camelCase 未泄漏 tier_id
    expect(body.plans[1]).toHaveProperty("priceMonthYuan")
  })

  it("progressive 只含 current + next 两键", async () => {
    const res = await app.request("/api/membership", { headers: auth() })
    const body = (await res.json()) as any
    expect(Object.keys(body.progressive).sort()).toEqual(["current", "next"])
    expect(body.progressive.current.tierId).toBe("free") // 未订阅
    expect(body.progressive.next.tierId).toBe("personal")
  })
})
