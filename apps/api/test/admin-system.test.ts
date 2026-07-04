import { describe, it, expect, afterAll, setDefaultTimeout } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import { Hono } from "hono"
import { adminRoutes } from "../src/routes/admin"
import { listAdmins, createAdminAccount, updateAdminAccount, listAuditLogs } from "../src/services/admin/admin-accounts"
import { getDb, closeDb } from "../src/db/client"
import { adminUsers } from "../src/db/schema"
import { makeAdminSession, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/admin-system.test.ts）

const app = new Hono()
app.route("/admin-api", adminRoutes())
const madeAdmins: string[] = []
const regA = (id: string) => madeAdmins.push(id)

afterAll(async () => {
  await getDb().delete(adminUsers).where(inArray(adminUsers.id, madeAdmins))
  await closeDb()
})

describe("spec310 系统页", () => {
  it("未登录 → 401", async () => {
    expect((await app.request("http://x/admin-api/overview")).status).toBe(401)
  })

  it("运营账号 CRUD + 改角色走审计", async () => {
    const a = await createAdminAccount({ username: `ops_new_${Date.now()}`, role: "ops", password: "pw123456" }, { operator: "superadmin_root" })
    madeAdmins.push(a.id)
    expect(a.role).toBe("ops")
    const upd = await updateAdminAccount(a.id, { role: "finance", status: "disabled" }, { operator: "superadmin_root" })
    expect(upd.role).toBe("finance")
    expect(upd.status).toBe("disabled")
    const list = await listAdmins({ page: 1, pageSize: 100 })
    expect((list.items[0] as Record<string, unknown>).passwordHash).toBeUndefined() // 不泄漏 hash
  })

  it("审计日志查询：按动作过滤 + 分页", async () => {
    const r = await listAuditLogs({ action: "admin.manage", page: 1, pageSize: 50 })
    expect(r.items.every((l) => l.action === "admin.manage")).toBe(true)
    expect(typeof r.total).toBe("number")
  })

  it("ops 管理运营账号 → 403（仅 superadmin admin.manage）", async () => {
    const { headers } = await makeAdminSession("ops", regA)
    const res = await app.request("http://x/admin-api/admins", { method: "POST", headers, body: JSON.stringify({ username: "x", role: "support", password: "pw123456" }) })
    expect(res.status).toBe(403)
  })

  it("superadmin 建账号 → 200", async () => {
    const { headers } = await makeAdminSession("superadmin", regA)
    const res = await app.request("http://x/admin-api/admins", { method: "POST", headers, body: JSON.stringify({ username: `sa_new_${Date.now()}`, role: "support", password: "pw123456" }) })
    expect(res.status).toBe(200)
    madeAdmins.push(((await res.json()) as { id: string }).id)
  })
})
