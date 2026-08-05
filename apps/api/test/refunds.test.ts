import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { randomUUID } from "node:crypto"
import { and, eq, inArray, lt } from "drizzle-orm"
import { getDb, closeDb } from "../src/db/client"
import { users, plans, paymentOrders, refunds, creditTransactions, reconcileDiffs, subscriptions } from "../src/db/schema"
import { createRefund, refundRequestNo, type RefundProvider } from "../src/services/refunds"
import { scanStuckRefunds } from "../src/services/reconcile"
import { getBalance, grant, hold, settle } from "../src/services/credits"
import { seedConfigs } from "../src/services/config"
import { makeLedgerUser, makeTestOrder, makeTestPlan, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/refunds.test.ts）

const madeUsers: string[] = []
const madePlans: string[] = []
let planId = ""

beforeAll(async () => {
  await seedConfigs()
  planId = await makeTestPlan((id) => madePlans.push(id), { name: "测试月卡-refund" })
})

afterAll(async () => {
  for (const id of madeUsers) await getDb().delete(users).where(eq(users.id, id)) // 订单/退款/流水级联删
  await getDb().delete(plans).where(inArray(plans.id, madePlans))
  await closeDb()
})

const mkUser = () => makeLedgerUser((id) => madeUsers.push(id))

const mkPaidOrder = (userId: string, amountCents: number, extra: Partial<typeof paymentOrders.$inferInsert> = {}) =>
  makeTestOrder(userId, "paid", amountCents, { providerTradeNo: `T-${randomUUID().slice(0, 8)}`, ...extra })

const okProvider = (calls: Array<{ clientSn: string; refundSn: string; amountCents: number }> = []): RefundProvider => ({
  refund: async (a) => {
    calls.push(a)
    return { ok: true }
  },
})
const failProvider: RefundProvider = { refund: async () => ({ ok: false }) }
// 带原因的拒绝：通道拒绝必须把原因带回运营后台，否则界面只能说一句"退款失败"
const failWithReason: RefundProvider = { refund: async () => ({ ok: false, reason: "REFUND_REJECT 超过可退期限" }) }

describe("spec306 退款编排（pending→done/failed，事务落账+扣回积分）", () => {
  it("全额退款：done + 订单 refunded + 按 ref=order 扣回已入账积分（负向 refund_clawback）", async () => {
    const userId = await mkUser()
    const order = await mkPaidOrder(userId, 1000)
    await grant(userId, 1000, { type: "purchase", ref: order.id, idempotencyKey: `rf-g-${order.id}` }) // 充值到账
    expect(await getBalance(userId)).toBe(1000)

    const calls: Array<{ clientSn: string; refundSn: string; amountCents: number }> = []
    const res = await createRefund(
      { orderId: order.id, amountCents: 1000, reason: "用户申请", operator: "ops_alice" },
      { provider: okProvider(calls) },
    )
    expect(res.status).toBe("done")
    expect(calls[0]!.clientSn).toBe(order.clientSn) // 按我方订单号退款
    // 生产实测：refundSn 直传 refunds.id（36 字符 UUID）会被收钱吧以「refund_request_no
    // …不可超过31字符」拒绝——每一笔退款都会以此失败，此前误判为通道拒绝。现在传的是
    // 从 refundId 派生的定长压缩值（"rf"+29 位十六进制=31 字符），同一退款单可重算复现。
    expect(calls[0]!.refundSn).toBe(refundRequestNo(res.refundId))
    expect(calls[0]!.refundSn.length).toBeLessThanOrEqual(31)

    const [r] = await getDb().select().from(refunds).where(eq(refunds.id, res.refundId))
    expect(r!.status).toBe("done")
    expect(r!.operator).toBe("ops_alice")
    expect((await getDb().select().from(paymentOrders).where(eq(paymentOrders.id, order.id)))[0]!.status).toBe("refunded")

    const negatives = await getDb()
      .select()
      .from(creditTransactions)
      .where(and(eq(creditTransactions.userId, userId), lt(creditTransactions.amount, 0)))
    expect(negatives).toHaveLength(1)
    expect(negatives[0]!.type).toBe("refund_clawback")
    expect(negatives[0]!.amount).toBe(-1000)
    expect(await getBalance(userId)).toBe(0)
  })

  it("部分退款：订单留 paid（剩余额度可续退）、累计比例扣回不随笔数放大取整误差", async () => {
    const userId = await mkUser()
    const order = await mkPaidOrder(userId, 1000)
    await grant(userId, 500, { type: "purchase", ref: order.id, idempotencyKey: `rf-g-${order.id}` })

    const r1 = await createRefund({ orderId: order.id, amountCents: 400, reason: "部分退", operator: "ops_bob" }, { provider: okProvider() })
    expect(r1.status).toBe("done")
    expect(await getBalance(userId)).toBe(300) // 500 - round(500×0.4)=200
    expect((await getDb().select().from(paymentOrders).where(eq(paymentOrders.id, order.id)))[0]!.status).toBe("paid") // 未退满不翻转

    const r2 = await createRefund({ orderId: order.id, amountCents: 600, reason: "退剩余", operator: "ops_bob" }, { provider: okProvider() })
    expect(r2.status).toBe("done")
    expect(await getBalance(userId)).toBe(0) // 累计口径：round(500×1.0)-200=300，合计恰好 500
    expect((await getDb().select().from(paymentOrders).where(eq(paymentOrders.id, order.id)))[0]!.status).toBe("refunded") // 退满才翻转
  })

  it("通道抛错（结果不明）→ 保持 pending 不标 failed：占累计额度挡重试，防换 refundSn 双退", async () => {
    const userId = await mkUser()
    const order = await mkPaidOrder(userId, 500)
    const throwing: RefundProvider = {
      refund: async () => {
        throw new Error("收钱吧网关 HTTP 504")
      },
    }
    const res = await createRefund({ orderId: order.id, amountCents: 500, reason: "x", operator: "ops" }, { provider: throwing })
    expect(res.status).toBe("pending")
    expect((await getDb().select().from(refunds).where(eq(refunds.id, res.refundId)))[0]!.status).toBe("pending")
    // pending 占额度：重试被累计护栏挡住（必须先人工核对通道，防双退）
    await expect(
      createRefund({ orderId: order.id, amountCents: 500, reason: "重试", operator: "ops" }, { provider: okProvider() }),
    ).rejects.toThrow(/退款金额超出订单金额/)
    // 卡死退款被扫描落 refund_stuck 差异（回拨 createdAt 模拟超时）
    await getDb().update(refunds).set({ createdAt: new Date(Date.now() - 2 * 3600_000) }).where(eq(refunds.id, res.refundId))
    const found = await scanStuckRefunds(new Date(), { alertHook: () => {} })
    expect(found).toBeGreaterThanOrEqual(1)
    const diffRows = await getDb().select().from(reconcileDiffs).where(eq(reconcileDiffs.subject, res.refundId))
    expect(diffRows.map((d) => d.diffType)).toContain("refund_stuck")
    await getDb().delete(reconcileDiffs).where(eq(reconcileDiffs.subject, res.refundId)) // 清理
  })

  it("扣回超过当前余额（用户已消费）默认拒绝；操作员携 allowNegativeBalance 才放行（余额转负）", async () => {
    const userId = await mkUser()
    const order = await mkPaidOrder(userId, 1000)
    await grant(userId, 1000, { type: "purchase", ref: order.id, idempotencyKey: `rf-g-${order.id}` })
    const { holdId } = await hold(userId, "read", { idempotencyKey: `rf-h-${userId}` })
    await settle(holdId, 10, { idempotencyKey: `rf-s-${userId}` }) // 已消费 10 → 余额 990 < 扣回 1000
    await expect(
      createRefund({ orderId: order.id, amountCents: 1000, reason: "x", operator: "ops" }, { provider: okProvider() }),
    ).rejects.toThrow(/超过当前余额/)
    const res = await createRefund(
      { orderId: order.id, amountCents: 1000, reason: "确认负余额", operator: "ops", allowNegativeBalance: true },
      { provider: okProvider() },
    )
    expect(res.status).toBe("done")
    expect(await getBalance(userId)).toBe(-10) // 欠账可见，审计可查
  })

  it("通道退款失败：refunds=failed，订单/积分原样不动", async () => {
    const userId = await mkUser()
    const order = await mkPaidOrder(userId, 500)
    await grant(userId, 500, { type: "purchase", ref: order.id, idempotencyKey: `rf-g-${order.id}` })

    const res = await createRefund({ orderId: order.id, amountCents: 500, reason: "x", operator: "ops_carol" }, { provider: failProvider })
    expect(res.status).toBe("failed")
    expect((await getDb().select().from(refunds).where(eq(refunds.id, res.refundId)))[0]!.status).toBe("failed")
    expect((await getDb().select().from(paymentOrders).where(eq(paymentOrders.id, order.id)))[0]!.status).toBe("paid")
    expect(await getBalance(userId)).toBe(500)
  })

  it("通道拒绝要把原因带回调用方（运营后台据此提示，否则只能显示一句「退款失败」）", async () => {
    const userId = await mkUser()
    const order = await mkPaidOrder(userId, 100)
    const res = await createRefund(
      { orderId: order.id, amountCents: 100, reason: "用户申请", operator: "ops_dave" },
      { provider: failWithReason },
    )
    expect(res.status).toBe("failed")
    expect(res.reason).toContain("超过可退期限")
    // 订单保持已支付：退款没成功就绝不能翻成已退款（生产实测：界面报成功、状态没变，运营以为退成功了）
    expect((await getDb().select().from(paymentOrders).where(eq(paymentOrders.id, order.id)))[0]!.status).toBe("paid")
  })

  it("护栏：非 paid 单拒绝；超额拒绝；累计（含在途 pending）超额拒绝", async () => {
    const userId = await mkUser()
    const created = await mkPaidOrder(userId, 500, { status: "created" })
    await expect(createRefund({ orderId: created.id, amountCents: 100, reason: "x", operator: "ops" }, { provider: okProvider() })).rejects.toThrow(/该订单当前是「待支付」/)

    const order = await mkPaidOrder(userId, 500)
    await expect(createRefund({ orderId: order.id, amountCents: 501, reason: "x", operator: "ops" }, { provider: okProvider() })).rejects.toThrow(/退款金额超出订单金额/)

    // 先退 300（done，订单留 paid），再退 300 → 累计 600 > 500 被护栏拒绝
    await createRefund({ orderId: order.id, amountCents: 300, reason: "第一笔", operator: "ops" }, { provider: okProvider() })
    await expect(
      createRefund({ orderId: order.id, amountCents: 300, reason: "第二笔", operator: "ops" }, { provider: okProvider() }),
    ).rejects.toThrow(/退款金额超出订单金额/)
  })

  it("会员单全额退：退钱 + 回退一个订阅周期 + 扣回该周期积分，三件事同一事务", async () => {
    // 2026-08-05 放开（原 C9 是整类转人工）：只退钱不回退周期 = 钱退了会员还在，故三件事必须一起发生。
    const userId = await mkUser()
    const order = await mkPaidOrder(userId, 2000, { type: "renewal", planId, cycleSnapshot: "month", creditsSnapshot: 200 })
    await grant(userId, 200, { type: "grant", ref: order.id, idempotencyKey: `rf-g-${order.id}` })
    // 续费结算的效果：会员有效期顺延一个月
    const periodStart = new Date()
    const periodEnd = new Date(periodStart.getTime() + 31 * 24 * 3600 * 1000)
    await getDb().insert(subscriptions).values({
      userId, planId, status: "active", currentPeriodStart: periodStart, currentPeriodEnd: periodEnd,
    })

    const res = await createRefund(
      { orderId: order.id, amountCents: 2000, reason: "用户申请", operator: "ops" },
      { provider: okProvider() },
    )
    expect(res.status).toBe("done")

    const [o] = await getDb().select().from(paymentOrders).where(eq(paymentOrders.id, order.id))
    expect(o!.status).toBe("refunded")
    expect(await getBalance(userId)).toBe(0) // 该周期积分被收回

    const [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.userId, userId))
    expect(sub!.currentPeriodEnd!.getTime()).toBeLessThan(Date.now()) // 顺延被抵消 → 已到期
    expect(sub!.status).toBe("expired")
    expect(sub!.currentPeriodStart!.getTime()).toBeLessThanOrEqual(sub!.currentPeriodEnd!.getTime()) // 不出现「开始晚于结束」
  })

  it("会员单缺周期快照：必须在调通道**之前**拒绝——不能钱退出去了才发现回退不了", async () => {
    // 评审 HIGH：原实现把这个检查放在落账事务里，而落账发生在通道退款成功之后 →
    // 真钱已退、事务回滚、退款单留 pending、订单仍 paid、积分没扣回，商户白亏一笔且无成功记录。
    const userId = await mkUser()
    // 套餐也查不到周期（planId 为空）⇒ 无从解析，只能拒
    const order = await mkPaidOrder(userId, 2000, { type: "renewal", planId: null, cycleSnapshot: null })
    let called = 0
    const spy: RefundProvider = { refund: async () => { called++; return { ok: true } } }
    await expect(
      createRefund({ orderId: order.id, amountCents: 2000, reason: "x", operator: "ops" }, { provider: spy }),
    ).rejects.toThrow(/周期/)
    expect(called).toBe(0) // 通道一次都没被调用 —— 钱没动
    expect(await getDb().select().from(refunds).where(eq(refunds.orderId, order.id))).toHaveLength(0)
  })

  it("会员单缺周期快照但套餐还在：按套餐当前周期回退（与入账时同一口径）", async () => {
    // renewOnPaid 缺快照时就是回退 plan.billing_cycle 发的权益，退的时候必须用同一个口径，否则不对称
    const userId = await mkUser()
    const order = await mkPaidOrder(userId, 2000, { type: "renewal", planId, cycleSnapshot: null })
    const periodEnd = new Date(Date.now() + 31 * 24 * 3600 * 1000)
    await getDb().insert(subscriptions).values({
      userId, planId, status: "active", currentPeriodStart: new Date(), currentPeriodEnd: periodEnd,
    })
    const res = await createRefund(
      { orderId: order.id, amountCents: 2000, reason: "x", operator: "ops" },
      { provider: okProvider() },
    )
    expect(res.status).toBe("done")
    const [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.userId, userId))
    expect(sub!.currentPeriodEnd!.getTime()).toBeLessThan(periodEnd.getTime()) // 周期确实被回退了
  })

  it("连续续费两期后退掉一期：剩余期仍有效，本期区间不能塌成一个点", async () => {
    // 评审 LOW：renewOnPaid 提前续费时 start = 上期末，回退一个周期后 start 正好 === newEnd，
    // 会员中心的「本期区间」会渲染成 "2026-09-05 ~ 2026-09-05"。
    const userId = await mkUser()
    const order = await mkPaidOrder(userId, 2000, { type: "renewal", planId, cycleSnapshot: "month", creditsSnapshot: 0 })
    // 必须落在"恰好相等"那一点上：renewOnPaid 提前续费时 start = 上期末，
    // 且 end = 上期末 + 一个整月，故回退一个月后 newEnd 与 start 严格相等（差一天就测不到）。
    const now = Date.now()
    const firstEnd = new Date(Date.UTC(2027, 0, 5, 12))   // 第一期末（未来）
    const secondEnd = new Date(Date.UTC(2027, 1, 5, 12))  // 第二期顺延一个整月
    await getDb().insert(subscriptions).values({
      userId, planId, status: "active", currentPeriodStart: firstEnd, currentPeriodEnd: secondEnd,
    })

    await createRefund({ orderId: order.id, amountCents: 2000, reason: "x", operator: "ops" }, { provider: okProvider() })

    const [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.userId, userId))
    expect(sub!.status).toBe("active")                                             // 第一期还在，权益不该断
    expect(sub!.currentPeriodEnd!.getTime()).toBeGreaterThan(now)
    expect(sub!.currentPeriodEnd!.getTime()).toBe(firstEnd.getTime())              // 恰好回到第一期末
    expect(sub!.currentPeriodStart!.getTime()).toBeLessThan(sub!.currentPeriodEnd!.getTime()) // 区间不是一个点
  })

  it("会员单部分退款仍拒绝：半个周期无法回退，报错要说清并给出路", async () => {
    const userId = await mkUser()
    const order = await mkPaidOrder(userId, 2000, { type: "renewal", planId, cycleSnapshot: "month", creditsSnapshot: 200 })
    const err = await createRefund(
      { orderId: order.id, amountCents: 500, reason: "x", operator: "ops" },
      { provider: okProvider() },
    ).then(() => null, (e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain("全额退款")
    expect(err!.message).toContain("¥20.00")      // 金额说元，不甩「分」
    expect(err!.message).not.toContain("renewal") // 不甩英文枚举名
    expect((await getDb().select().from(refunds).where(eq(refunds.orderId, order.id)))).toHaveLength(0) // 不建退款单
  })

  it("无入账积分的订单退款：不写负向流水", async () => {
    const userId = await mkUser()
    const order = await mkPaidOrder(userId, 300) // 无 ref=order 的正向流水
    const res = await createRefund({ orderId: order.id, amountCents: 300, reason: "x", operator: "ops" }, { provider: okProvider() })
    expect(res.status).toBe("done")
    const negatives = await getDb()
      .select()
      .from(creditTransactions)
      .where(and(eq(creditTransactions.userId, userId), lt(creditTransactions.amount, 0)))
    expect(negatives).toHaveLength(0)
  })
})

describe("refundRequestNo：收钱吧 refund_request_no 31 字符硬上限", () => {
  it("标准 UUID（36 字符）压缩到 31 字符以内，且同一 id 可重算复现", () => {
    const id = "12241d58-55f1-446a-af2b-e27d451debcc"
    const out = refundRequestNo(id)
    expect(out.length).toBeLessThanOrEqual(31)
    expect(out).toBe(refundRequestNo(id)) // 纯函数：同一退款单每次重算得到同一个值，通道侧幂等键才稳定
  })
})

describe("扣回护栏拒绝后，操作员确认重试必须真的重试", () => {
  it("护栏拒绝的行不占用幂等键 —— 否则确认后的重试被当成重放，直接返回上次的 failed", async () => {
    // 生产实测（2026-07-31）：后台确认弹层沿用同一 idempotencyKey 重发（本意是防双退），
    // 但第一次已被扣回护栏标成 failed，于是第二次走幂等重放：不调通道、不带 reason、
    // 直接回上次的 failed。运营点「确认退款」等于什么都没发生，界面还显示「通道未返回原因」——
    // 而通道根本没被调用过。护栏是**通道调用之前**的拒绝，一分钱没动，
    // 那行就不该霸占这个键挡住后续重试；幂等键的职责是挡重复的通道调用。
    const userId = await mkUser()
    const order = await mkPaidOrder(userId, 1000)
    await grant(userId, 1000, { type: "purchase", ref: order.id, idempotencyKey: `rfk-g-${order.id}` })
    const { holdId } = await hold(userId, "read", { idempotencyKey: `rfk-h-${userId}` })
    await settle(holdId, 10, { idempotencyKey: `rfk-s-${userId}` })   // 余额 990 < 扣回 1000

    const key = randomUUID()
    await expect(
      createRefund({ orderId: order.id, amountCents: 1000, reason: "第一次", operator: "ops", idempotencyKey: key },
                   { provider: okProvider() }),
    ).rejects.toThrow(/allowNegativeBalance/)

    // 同一个 key 确认重试：必须真的走通道，而不是被当成重放直接回上次的 failed
    const calls: Array<{ clientSn: string; refundSn: string; amountCents: number }> = []
    const res = await createRefund(
      { orderId: order.id, amountCents: 1000, reason: "确认", operator: "ops",
        idempotencyKey: key, allowNegativeBalance: true },
      { provider: okProvider(calls) },
    )
    expect(res.status).toBe("done")
    expect(calls.length).toBe(1)   // 通道被真正调用过一次——这正是此前缺失的
  })
})

describe("退款结果落审计（评审实测：此前只 console.info，审计里只有「发起退款」没有成败）", () => {
  it("成功 → refund.done；通道拒绝 → refund.failed；target 指向该订单", async () => {
    const { adminAuditLogs } = await import("../src/db/schema")
    const auditOf = async (action: string, orderId: string) => {
      // auditLog 是 best-effort 异步（不阻塞退款事务）——轮询等它落库，不用固定 sleep
      for (let i = 0; i < 20; i++) {
        const rows = await getDb().select().from(adminAuditLogs)
          .where(and(eq(adminAuditLogs.action, action), eq(adminAuditLogs.target, `order:${orderId}`)))
        if (rows.length > 0) return rows
        await new Promise((r) => setTimeout(r, 100))
      }
      return []
    }

    const okOrder = await mkPaidOrder(await mkUser(), 1000)
    await createRefund({ orderId: okOrder.id, amountCents: 1000, reason: "审计验证", operator: "ops_audit" },
      { provider: okProvider() })
    expect((await auditOf("refund.done", okOrder.id)).length).toBe(1)

    const badOrder = await mkPaidOrder(await mkUser(), 1000)
    await createRefund({ orderId: badOrder.id, amountCents: 1000, reason: "审计验证", operator: "ops_audit" },
      { provider: failProvider })
    expect((await auditOf("refund.failed", badOrder.id)).length).toBe(1)
  })
})
