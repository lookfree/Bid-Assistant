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

// 断言约束冲突：插入等必须抛错（drizzle insert 是 thenable，统一用显式 try/catch）。
export async function expectConflict(fn: () => Promise<unknown>): Promise<void> {
  let threw = false
  try {
    await fn()
  } catch {
    threw = true
  }
  if (!threw) throw new Error("预期约束冲突抛错，但没有抛")
}

// 账本类测试用：建一个唯一手机号测试用户并登记 id（调用方负责 afterAll 级联删）。
const madeSeq = { n: 0 }
export async function makeLedgerUser(register: (id: string) => void): Promise<string> {
  const u = await createTestUser(`+8613${Date.now().toString().slice(-8)}${(madeSeq.n++ % 90) + 10}`.slice(0, 14))
  register(u.id)
  return u.id
}
