import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { createSession, findValidSession, revokeSession } from "../../src/repos/sessions"
import { TEST_TIMEOUT_MS, uniquePhone, createTestUser, deleteTestUser } from "./helpers"

setDefaultTimeout(TEST_TIMEOUT_MS)

const phone = uniquePhone()
let userId = ""

beforeAll(async () => {
  userId = (await createTestUser(phone)).id
})
afterAll(async () => {
  await deleteTestUser(userId) // 级联删 sessions/identities
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
