import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { referralRoutes } from "../src/routes/referral"
import { getMyCode, bindByCode } from "../src/services/referral"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users } from "../src/db/schema"
import { seedConfigs } from "../src/services/config"
import { makeLedgerUser, uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/referral-routes.test.ts）

const madeUsers: string[] = []
const app = new Hono()
app.route("/api/referral", referralRoutes())

let token = ""
let userId = ""

beforeAll(async () => {
  await seedConfigs()
  const a = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  token = a.token
  userId = a.user.id
})
afterAll(async () => {
  await getDb().delete(users).where(eq(users.id, userId))
  for (const id of madeUsers) await getDb().delete(users).where(eq(users.id, id))
  await closeDb()
})

const auth = () => ({ Authorization: `Bearer ${token}` }) // 函数：读取 beforeAll 设好的 token（非模块加载时的空串）

describe("spec307 推荐路由", () => {
  it("未登录 401", async () => {
    expect((await app.request("/api/referral/code")).status).toBe(401)
  })

  it("GET /code 返回我的邀请码（幂等同一码）", async () => {
    const r1 = await app.request("/api/referral/code", { headers: auth() })
    const r2 = await app.request("/api/referral/code", { headers: auth() })
    expect(r1.status).toBe(200)
    const c1 = (await r1.json()) as { code: string }
    const c2 = (await r2.json()) as { code: string }
    expect(c1.code).toBe(c2.code)
    expect(c1.code.length).toBe(6)
  })

  it("GET /list 返回邀请列表 + 奖励状态", async () => {
    const invitee = await makeLedgerUser((id) => madeUsers.push(id))
    await bindByCode({ code: await getMyCode(userId), inviteeId: invitee })
    const res = await app.request("/api/referral/list", { headers: auth() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { list: Array<{ inviteeId: string; status: string; rewardState: string }> }
    expect(body.list.length).toBeGreaterThanOrEqual(1)
    const mine = body.list.find((x) => x.inviteeId === invitee)
    expect(mine).toBeDefined()
    expect(mine).toHaveProperty("rewardState")
    expect(mine).toHaveProperty("status")
  })
})
