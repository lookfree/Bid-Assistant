import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { adminRoutes } from "../src/routes/admin"
import { listUsers, banUser, unbanUser, adminGrantCredits } from "../src/services/admin/admin-users"
import { getDb, closeDb } from "../src/db/client"
import { users, adminUsers, adminAuditLogs } from "../src/db/schema"
import { makeUserWithNickname, makeAdminSession, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/admin-users.test.ts）

const app = new Hono()
app.route("/admin-api", adminRoutes())
const madeUsers: string[] = []
const madeAdmins: string[] = []
const regU = (id: string) => madeUsers.push(id)
const regA = (id: string) => madeAdmins.push(id)

afterAll(async () => {
  for (const id of madeUsers) await getDb().delete(users).where(eq(users.id, id))
  for (const id of madeAdmins) await getDb().delete(adminUsers).where(eq(adminUsers.id, id))
  await closeDb()
})

describe("spec310 用户页", () => {
  it("列表 + 关键字搜索（nickname）+ 分页", async () => {
    const tag = `alice-${Date.now()}`
    const a = await makeUserWithNickname(regU, tag)
    await makeUserWithNickname(regU, `bob-${Date.now()}`)
    const r = await listUsers({ q: tag, page: 1, pageSize: 10 })
    expect(r.total).toBe(1)
    expect(r.items[0]!.id).toBe(a)
  })

  it("封禁/解封 + 审计前后值", async () => {
    const u = await makeUserWithNickname(regU)
    await banUser(u, { operator: "ops_alice" })
    expect((await getDb().select().from(users).where(eq(users.id, u)))[0]!.status).toBe("banned")
    const logs = await getDb().select().from(adminAuditLogs).where(eq(adminAuditLogs.target, `user:${u}`))
    expect(logs.length).toBeGreaterThanOrEqual(1)
    expect((logs.at(-1)!.before as { status: string }).status).toBe("active")
    expect((logs.at(-1)!.after as { status: string }).status).toBe("banned")
    await unbanUser(u, { operator: "ops_alice" })
    expect((await getDb().select().from(users).where(eq(users.id, u)))[0]!.status).toBe("active")
  })

  it("手动加/扣积分：走 adminAdjust（±）+ 审计", async () => {
    const u = await makeUserWithNickname(regU)
    const r1 = await adminGrantCredits(u, { amount: 200, reason: "补偿", operator: "ops", adminId: "adm1" })
    expect(r1.balance).toBe(200)
    const r2 = await adminGrantCredits(u, { amount: -30, reason: "扣回", operator: "ops", adminId: "adm1" })
    expect(r2.balance).toBe(170)
    const logs = await getDb().select().from(adminAuditLogs).where(eq(adminAuditLogs.target, `user:${u}`))
    expect(logs.some((l) => l.action === "credit.adjust")).toBe(true)
  })

  it("扣积分超余额 → 拒绝（不扣穿到负）", async () => {
    const u = await makeUserWithNickname(regU)
    await adminGrantCredits(u, { amount: 50, reason: "init", operator: "ops", adminId: "adm1" })
    await expect(adminGrantCredits(u, { amount: -100, reason: "over", operator: "ops", adminId: "adm1" })).rejects.toThrow()
  })

  it("support 调封禁路由 → 403", async () => {
    const u = await makeUserWithNickname(regU)
    const { headers } = await makeAdminSession("support", regA)
    const res = await app.request(`http://x/admin-api/users/${u}/ban`, { method: "POST", headers })
    expect(res.status).toBe(403)
  })

  it("ops 调封禁路由 → 200（有 user.write）", async () => {
    const u = await makeUserWithNickname(regU)
    const { headers } = await makeAdminSession("ops", regA)
    const res = await app.request(`http://x/admin-api/users/${u}/ban`, { method: "POST", headers })
    expect(res.status).toBe(200)
  })

  it("未登录 → 401", async () => {
    expect((await app.request("http://x/admin-api/users")).status).toBe(401)
  })
})
