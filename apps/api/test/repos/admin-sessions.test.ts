import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { createAdminSession, findValidAdminSession, revokeAdminSession } from "../../src/repos/admin-sessions"
import { createAdmin } from "../../src/repos/admin-users"
import { getDb, closeDb } from "../../src/db/client"
import { adminUsers } from "../../src/db/schema"
import { TEST_TIMEOUT_MS } from "./helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/repos/admin-sessions.test.ts）

let adminId = ""

beforeAll(async () => {
  const a = await createAdmin({ username: `sess_${Date.now()}`, passwordHash: "h", role: "support" })
  adminId = a.id
})
afterAll(async () => {
  await getDb().delete(adminUsers).where(eq(adminUsers.id, adminId)) // 级联删 admin_sessions
  await closeDb()
})

describe("spec309 admin-sessions 仓储（独立会话）", () => {
  it("create 后 findValid 取回", async () => {
    const s = await createAdminSession({ adminId, tokenHash: "ah-a", expiresAt: new Date(Date.now() + 3600_000) })
    expect(s.adminId).toBe(adminId)
    expect((await findValidAdminSession("ah-a"))?.id).toBe(s.id)
  })

  it("过期会话无效", async () => {
    await createAdminSession({ adminId, tokenHash: "ah-expired", expiresAt: new Date(Date.now() - 1000) })
    expect(await findValidAdminSession("ah-expired")).toBeNull()
  })

  it("撤销的会话无效", async () => {
    const s = await createAdminSession({ adminId, tokenHash: "ah-revoke", expiresAt: new Date(Date.now() + 3600_000) })
    await revokeAdminSession(s.id)
    expect(await findValidAdminSession("ah-revoke")).toBeNull()
  })
})
