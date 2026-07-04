import { describe, it, expect, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { createAdmin, findAdminByUsername, getAdminById, setAdminStatus } from "../../src/repos/admin-users"
import { getDb, closeDb } from "../../src/db/client"
import { adminUsers } from "../../src/db/schema"
import { TEST_TIMEOUT_MS } from "./helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/repos/admin-users.test.ts）

const username = `ops_${Date.now()}`
let createdId = ""

afterAll(async () => {
  if (createdId) await getDb().delete(adminUsers).where(eq(adminUsers.id, createdId))
  await closeDb()
})

describe("spec309 admin-users 仓储（独立于 C 端）", () => {
  it("createAdmin 后 findAdminByUsername 取回同一账号", async () => {
    const a = await createAdmin({ username, passwordHash: "hash-x", role: "ops" })
    createdId = a.id
    expect(a.role).toBe("ops")
    expect(a.status).toBe("active")
    expect((await findAdminByUsername(username))?.id).toBe(a.id)
  })

  it("getAdminById / 未知 username → null", async () => {
    expect((await getAdminById(createdId))?.id).toBe(createdId)
    expect(await findAdminByUsername("no_such_admin")).toBeNull()
    expect(await getAdminById("00000000-0000-0000-0000-000000000000")).toBeNull()
  })

  it("setAdminStatus 停用账号", async () => {
    await setAdminStatus(createdId, "disabled")
    expect((await getAdminById(createdId))?.status).toBe("disabled")
  })
})
