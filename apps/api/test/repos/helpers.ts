import { createUserWithIdentity } from "../../src/repos/users"
import { getDb } from "../../src/db/client"
import { users, type User } from "../../src/db/schema"
import { eq } from "drizzle-orm"

// 集成测试连远程 bidsaas（公网往返较慢），统一放宽默认超时（各测试文件 setDefaultTimeout 用）。
export const TEST_TIMEOUT_MS = 20000

// 每次调用生成一个唯一手机号，避免跨运行/跨用例撞 UNIQUE(provider,identifier)。
export const uniquePhone = () => `+8613${Date.now().toString().slice(-9)}`

export async function createTestUser(phone: string): Promise<User> {
  return createUserWithIdentity({ provider: "phone", identifier: phone, verifiedAt: new Date() })
}

// 级联删除（cascade 一并删 identities/sessions）。
export async function deleteTestUser(id: string): Promise<void> {
  await getDb().delete(users).where(eq(users.id, id))
}
