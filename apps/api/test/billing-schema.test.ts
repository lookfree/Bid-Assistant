import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import {
  users,
  plans,
  subscriptions,
  creditTransactions,
  creditBalances,
  paymentOrders,
  paymentTerminals,
  refunds,
  referrals,
} from "../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB

let userId = ""
let planId = ""

beforeAll(async () => {
  const r = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  userId = r.user.id
  const [p] = await getDb()
    .insert(plans)
    .values({ name: `测试版-${Date.now()}`, billingCycle: "month" })
    .returning()
  planId = p!.id
})

afterAll(async () => {
  // 订阅/流水/订单随 user 级联删；plan 单独清
  await getDb().delete(users).where(eq(users.id, userId))
  await getDb().delete(plans).where(eq(plans.id, planId))
  await closeDb()
})

// 幂等断言助手：同约束冲突必须抛错（drizzle insert 是 thenable，用显式 try/catch）
async function expectConflict(fn: () => Promise<unknown>) {
  let threw = false
  try {
    await fn()
  } catch {
    threw = true
  }
  expect(threw).toBe(true)
}

describe("spec301 计费数据模型", () => {
  it("plans 默认值：价格 0（不写死定价）、active、v1", async () => {
    const [p] = await getDb().select().from(plans).where(eq(plans.id, planId))
    expect(p!.priceCents).toBe(0)
    expect(p!.currency).toBe("CNY")
    expect(p!.status).toBe("active")
    expect(p!.version).toBe(1)
  })

  it("subscriptions 建订阅（无 auto_renew/agreement_no 字段）", async () => {
    const [s] = await getDb().insert(subscriptions).values({ userId, planId }).returning()
    expect(s!.status).toBe("active")
    expect("autoRenew" in s!).toBe(false)
    expect("agreementNo" in s!).toBe(false)
  })

  it("credit_transactions 追加 + 幂等键唯一（同键只入一次）", async () => {
    const key = `k-${crypto.randomUUID()}`
    await getDb().insert(creditTransactions).values({ userId, type: "grant", amount: 100, idempotencyKey: key })
    await expectConflict(() =>
      getDb().insert(creditTransactions).values({ userId, type: "grant", amount: 100, idempotencyKey: key }),
    )
    const rows = await getDb().select().from(creditTransactions).where(eq(creditTransactions.userId, userId))
    expect(rows).toHaveLength(1)
  })

  it("credit_balances 一人一行（主键 user_id）", async () => {
    await getDb().insert(creditBalances).values({ userId, balance: 100 })
    await expectConflict(() => getDb().insert(creditBalances).values({ userId, balance: 200 }))
  })

  it("payment_orders：client_sn 唯一 + 幂等键唯一 + 金额整数分", async () => {
    const sn = `bid-${crypto.randomUUID()}`
    const [o] = await getDb()
      .insert(paymentOrders)
      .values({ userId, type: "recharge", amountCents: 100, clientSn: sn, idempotencyKey: `i-${sn}` })
      .returning()
    expect(o!.provider).toBe("shouqianba")
    expect(o!.status).toBe("created")
    await expectConflict(() =>
      getDb()
        .insert(paymentOrders)
        .values({ userId, type: "recharge", amountCents: 100, clientSn: sn, idempotencyKey: `i2-${sn}` }),
    )
    await expectConflict(() =>
      getDb()
        .insert(paymentOrders)
        .values({ userId, type: "recharge", amountCents: 100, clientSn: `${sn}-b`, idempotencyKey: `i-${sn}` }),
    )
  })

  it("refunds 外键必须指向已有订单", async () => {
    await expectConflict(() =>
      getDb().insert(refunds).values({ orderId: crypto.randomUUID(), amountCents: 100 }),
    )
  })

  it("payment_terminals：terminal_sn / device_id 唯一", async () => {
    const sn = `t-${crypto.randomUUID()}`
    const dev = `dev-${crypto.randomUUID()}`
    await getDb().insert(paymentTerminals).values({ terminalSn: sn, terminalKey: "enc", deviceId: dev })
    await expectConflict(() =>
      getDb().insert(paymentTerminals).values({ terminalSn: sn, terminalKey: "enc", deviceId: `${dev}-b` }),
    )
    await expectConflict(() =>
      getDb().insert(paymentTerminals).values({ terminalSn: `${sn}-b`, terminalKey: "enc", deviceId: dev }),
    )
    // 清理（无级联挂靠）
    await getDb().delete(paymentTerminals).where(eq(paymentTerminals.terminalSn, sn))
  })

  it("referrals：一个被邀请人只属一个邀请关系（invitee 唯一）", async () => {
    const r2 = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
    try {
      await getDb().insert(referrals).values({ inviterId: userId, inviteeId: r2.user.id, code: "C1", status: "bound" })
      await expectConflict(() =>
        getDb().insert(referrals).values({ inviterId: userId, inviteeId: r2.user.id, code: "C2", status: "bound" }),
      )
    } finally {
      await getDb().delete(users).where(eq(users.id, r2.user.id))
    }
  })
})
