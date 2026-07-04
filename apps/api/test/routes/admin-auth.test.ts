import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { adminRoutes } from "../../src/routes/admin"
import { requireAdmin } from "../../src/middleware/admin-auth"
import { createAdmin } from "../../src/repos/admin-users"
import { hashPassword } from "../../src/services/admin-auth"
import { getDb, closeDb } from "../../src/db/client"
import { adminUsers } from "../../src/db/schema"
import { TEST_TIMEOUT_MS } from "../repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/routes/admin-auth.test.ts）

// 测试 app：挂 admin-api + 一条 finance-only 探针（验证 requireAdmin(role) 越权 403，不污染生产路由）
const app = new Hono()
app.route("/admin-api", adminRoutes())
app.get("/probe/finance", requireAdmin("finance"), (c) => c.json({ ok: true }))

const username = `e2e_${Date.now()}`
const password = "S3cret-pass!"
let supportId = ""

beforeAll(async () => {
  const a = await createAdmin({ username, passwordHash: await hashPassword(password), role: "support" })
  supportId = a.id
})
afterAll(async () => {
  await getDb().delete(adminUsers).where(eq(adminUsers.id, supportId))
  await closeDb()
})

const login = async (u = username, p = password) =>
  app.request("http://x/admin-api/login", { method: "POST", body: JSON.stringify({ username: u, password: p }) })

describe("spec309 admin-api 登录 / RBAC / 与 C 端隔离", () => {
  it("登录成功签发 token；错误口令 401", async () => {
    expect((await login(username, "wrong")).status).toBe(401)
    const res = await login()
    expect(res.status).toBe(200)
    expect(typeof ((await res.json()) as { token: string }).token).toBe("string")
  })

  it("me 需鉴权：无 token 401；带 admin token 返回 admin", async () => {
    expect((await app.request("http://x/admin-api/me")).status).toBe(401)
    const { token } = (await (await login()).json()) as { token: string }
    const me = await app.request("http://x/admin-api/me", { headers: { Authorization: `Bearer ${token}` } })
    expect(me.status).toBe(200)
    expect(((await me.json()) as { admin: { username: string } }).admin.username).toBe(username)
  })

  it("requireAdmin(role) 拒绝越权角色 403（support 调 finance-only）", async () => {
    const { token } = (await (await login()).json()) as { token: string }
    const r = await app.request("http://x/probe/finance", { headers: { Authorization: `Bearer ${token}` } })
    expect(r.status).toBe(403)
  })

  it("C 端 / 随机 token 不能访问 admin-api（隔离，401）", async () => {
    const r = await app.request("http://x/admin-api/me", { headers: { Authorization: "Bearer cside-token-deadbeef" } })
    expect(r.status).toBe(401)
  })

  it("登出后 token 失效（会话撤销）", async () => {
    const { token } = (await (await login()).json()) as { token: string }
    const auth = { Authorization: `Bearer ${token}` }
    expect((await app.request("http://x/admin-api/logout", { method: "POST", headers: auth })).status).toBe(204)
    expect((await app.request("http://x/admin-api/me", { headers: auth })).status).toBe(401)
  })
})
