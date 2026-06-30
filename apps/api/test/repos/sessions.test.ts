import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { createSession, findValidSession, revokeSession } from "../../src/repos/sessions"
import { createUserWithIdentity } from "../../src/repos/users"
import { getDb } from "../../src/db/client"
import { users } from "../../src/db/schema"
import { eq } from "drizzle-orm"

// 集成测试连远程 bidsaas（公网往返较慢），放宽默认超时。
setDefaultTimeout(20000)

const phone = `+8613${Date.now().toString().slice(-9)}`
let userId = ""

beforeAll(async () => {
  const u = await createUserWithIdentity({ provider: "phone", identifier: phone, verifiedAt: new Date() })
  userId = u.id
})
afterAll(async () => {
  await getDb().delete(users).where(eq(users.id, userId)) // 级联删 sessions/identities
})

describe("sessions repo", () => {
  it("createSession then findValidSession returns it", async () => {
    const s = await createSession({ userId, tokenHash: "hash-a", expiresAt: new Date(Date.now() + 3600_000) })
    expect(s.userId).toBe(userId)
    expect((await findValidSession("hash-a"))?.id).toBe(s.id)
  })

  it("expired session is not valid", async () => {
    await createSession({ userId, tokenHash: "hash-expired", expiresAt: new Date(Date.now() - 1000) })
    expect(await findValidSession("hash-expired")).toBeNull()
  })

  it("revoked session is not valid", async () => {
    const s = await createSession({ userId, tokenHash: "hash-revoke", expiresAt: new Date(Date.now() + 3600_000) })
    await revokeSession(s.id)
    expect(await findValidSession("hash-revoke")).toBeNull()
  })
})
