import { describe, it, expect, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { seedAdminRoles, seedSuperadmin } from "../src/config/admin-seed"
import { loginAdmin } from "../src/services/admin-auth"
import { getDb, closeDb } from "../src/db/client"
import { adminUsers } from "../src/db/schema"
import { TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/admin-seed.test.ts）

const username = `boot_${Date.now()}`
const password = "Boot-pass-123"

afterAll(async () => {
  await getDb().delete(adminUsers).where(eq(adminUsers.username, username))
  await closeDb()
})

describe("spec309 admin 种子", () => {
  it("seedAdminRoles 幂等（重复跑不报错）", async () => {
    await seedAdminRoles()
    await seedAdminRoles()
    expect(true).toBe(true)
  })

  it("seedSuperadmin 建账号后可登录", async () => {
    await seedSuperadmin({ ADMIN_BOOTSTRAP_USERNAME: username, ADMIN_BOOTSTRAP_PASSWORD: password })
    const r = await loginAdmin(username, password)
    expect(r?.admin.role).toBe("superadmin")
  })
})
