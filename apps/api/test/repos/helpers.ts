import { createUserWithIdentity } from "../../src/repos/users"
import { getDb } from "../../src/db/client"
import { users, plans, subscriptions, paymentOrders, type User } from "../../src/db/schema"
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

/** 订阅/续费测试共用：建测试套餐并登记清理（镜像 makeLedgerUser 模式）。 */
export async function makeTestPlan(
  register: (id: string) => void,
  overrides: Partial<{ name: string; priceCents: number; billingCycle: string; grantCreditsPerCycle: number }> = {},
): Promise<string> {
  const [p] = await getDb()
    .insert(plans)
    .values({
      name: overrides.name ?? `测试套餐-${Date.now().toString(36)}`,
      priceCents: overrides.priceCents ?? 1000,
      billingCycle: overrides.billingCycle ?? "month",
      grantCreditsPerCycle: overrides.grantCreditsPerCycle ?? 100,
    })
    .returning()
  register(p!.id)
  return p!.id
}

/** 建测试订阅（新用户 + 订阅行）：endOffsetMs 为 null 表示无周期末。返回订阅行。 */
export async function makeTestSubscription(
  registerUser: (id: string) => void,
  planId: string,
  status: string,
  endOffsetMs: number | null,
) {
  const userId = await makeLedgerUser(registerUser)
  const [s] = await getDb()
    .insert(subscriptions)
    .values({ userId, planId, status, currentPeriodEnd: endOffsetMs == null ? null : new Date(Date.now() + endOffsetMs) })
    .returning()
  return s!
}

/** 支付/对账测试共用：直插订单（绕过 createOrder 的频控与类型不变式，测试需精确控制字段）。 */
export async function makeTestOrder(
  userId: string,
  status: string,
  amountCents: number,
  extra: Record<string, unknown> = {},
): Promise<typeof paymentOrders.$inferSelect> {
  const { randomUUID } = await import("node:crypto")
  const [o] = await getDb()
    .insert(paymentOrders)
    .values({
      userId,
      type: "recharge",
      amountCents,
      status,
      clientSn: `t-${randomUUID()}`,
      idempotencyKey: `t-${randomUUID()}`,
      ...extra,
    } as typeof paymentOrders.$inferInsert)
    .returning()
  return o!
}
