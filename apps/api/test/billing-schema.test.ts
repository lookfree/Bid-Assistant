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
import { uniquePhone, TEST_TIMEOUT_MS, expectConflict } from "./repos/helpers"

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

  // 注册即赠积分（auth.grantSignupBonus）是每个真实用户的**起点**，本套件其余用例都以它为基线：
  // 生产里不存在「账本为空的注册用户」，测试也不许构造那个状态——那样测的是永远不会发生的场景。
  it("注册即赠：新用户开局就有一条 signup 流水与一行余额（后续用例的基线）", async () => {
    const txs = await getDb().select().from(creditTransactions).where(eq(creditTransactions.userId, userId))
    expect(txs).toHaveLength(1)
    expect(txs[0]!.type).toBe("grant")
    expect(txs[0]!.sourceBatch).toBe("signup")
    expect(txs[0]!.idempotencyKey).toBe(`signup_grant:${userId}`) // 每用户仅发一次
    const [bal] = await getDb().select().from(creditBalances).where(eq(creditBalances.userId, userId))
    expect(bal!.balance).toBe(txs[0]!.amount) // 余额缓存 = Σ流水
  })

  it("credit_transactions 追加 + 幂等键唯一（同键只入一次）", async () => {
    const before = await getDb().select().from(creditTransactions).where(eq(creditTransactions.userId, userId))
    const key = `k-${crypto.randomUUID()}`
    await getDb().insert(creditTransactions).values({ userId, type: "grant", amount: 100, idempotencyKey: key })
    await expectConflict(() =>
      getDb().insert(creditTransactions).values({ userId, type: "grant", amount: 100, idempotencyKey: key }),
    )
    // 断增量而非绝对条数：绝对值会把「注册赠多少」这个**运营可配**的值焊进测试
    const after = await getDb().select().from(creditTransactions).where(eq(creditTransactions.userId, userId))
    expect(after).toHaveLength(before.length + 1)
  })

  it("credit_balances 一人一行（主键 user_id）", async () => {
    // 注册时那行余额就是「第一行」，再插一行必冲突——不必也不该自己先造一行
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

  it("金额铁律：非正金额订单/退款被 DB CHECK 拒绝", async () => {
    await expectConflict(() =>
      getDb()
        .insert(paymentOrders)
        .values({ userId, type: "recharge", amountCents: -100, clientSn: `neg-${crypto.randomUUID()}`, idempotencyKey: `neg-${crypto.randomUUID()}` }),
    )
    await expectConflict(() =>
      getDb()
        .insert(paymentOrders)
        .values({ userId, type: "recharge", amountCents: 0, clientSn: `zero-${crypto.randomUUID()}`, idempotencyKey: `zero-${crypto.randomUUID()}` }),
    )
  })

  it("幂等键必填：缺 idempotency_key 的流水/订单被拒", async () => {
    await expectConflict(() =>
      getDb().insert(creditTransactions).values({ userId, type: "grant", amount: 1 } as never),
    )
  })

  it("枚举铁律：非法 type/status 被 DB CHECK 拒绝", async () => {
    await expectConflict(() =>
      getDb()
        .insert(creditTransactions)
        .values({ userId, type: "grantt", amount: 1, idempotencyKey: `bad-${crypto.randomUUID()}` }),
    )
    await expectConflict(() =>
      getDb()
        .insert(paymentOrders)
        .values({ userId, type: "renew", amountCents: 100, clientSn: `bt-${crypto.randomUUID()}`, idempotencyKey: `bt-${crypto.randomUUID()}` }),
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
