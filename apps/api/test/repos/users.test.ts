import { describe, it, expect, afterAll, setDefaultTimeout } from "bun:test"
import {
  getUserById,
  findUserByIdentity,
  createUserWithIdentity,
  addIdentity,
} from "../../src/repos/users"
import { IdentityAlreadyBoundError } from "../../src/repos/errors"
import { getDb } from "../../src/db/client"
import { users } from "../../src/db/schema"
import { eq } from "drizzle-orm"

// 集成测试连远程 bidsaas（公网往返较慢），放宽默认超时。
setDefaultTimeout(20000)

const phone = `+8613${Date.now().toString().slice(-9)}`
let createdId = ""

afterAll(async () => {
  if (createdId) await getDb().delete(users).where(eq(users.id, createdId)) // 级联删 identities
})

describe("users repo", () => {
  it("createUserWithIdentity then findUserByIdentity returns same user", async () => {
    const u = await createUserWithIdentity({ provider: "phone", identifier: phone, verifiedAt: new Date() })
    createdId = u.id
    expect(u.status).toBe("active")
    const found = await findUserByIdentity("phone", phone)
    expect(found?.id).toBe(u.id)
  })

  it("getUserById returns user; missing id -> null", async () => {
    expect((await getUserById(createdId))?.id).toBe(createdId)
    expect(await getUserById("00000000-0000-0000-0000-000000000000")).toBeNull()
  })

  it("findUserByIdentity returns null for unknown identity", async () => {
    expect(await findUserByIdentity("phone", "+860000000000")).toBeNull()
    expect(await findUserByIdentity("wechat", phone)).toBeNull()
  })

  it("addIdentity binds a second identity to the same user", async () => {
    await addIdentity(createdId, "wechat", `wx_${phone}`)
    const viaWechat = await findUserByIdentity("wechat", `wx_${phone}`)
    expect(viaWechat?.id).toBe(createdId)
  })

  it("addIdentity throws IdentityAlreadyBoundError on a taken identity", async () => {
    // 重复绑定同一 (wechat, wx_phone) → 命中 UNIQUE → 领域错误而非裸 500
    await expect(addIdentity(createdId, "wechat", `wx_${phone}`)).rejects.toBeInstanceOf(
      IdentityAlreadyBoundError,
    )
  })
})
