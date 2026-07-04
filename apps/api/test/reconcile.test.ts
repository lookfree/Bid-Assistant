import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { randomUUID } from "node:crypto"
import { and, eq, inArray } from "drizzle-orm"
import { getDb, closeDb } from "../src/db/client"
import { users, paymentOrders, reconcileDiffs, creditTransactions, creditBalances } from "../src/db/schema"
import { runReconcile, auditLedger, releaseOrphanHolds, type ReconcileProvider } from "../src/services/reconcile"
import { grant, hold, settle, getBalance } from "../src/services/credits"
import { seedConfigs } from "../src/services/config"
import { makeLedgerUser, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/reconcile.test.ts）

const madeUsers: string[] = []
const madeOrders: string[] = []
let userId = ""
const BILL_DATE = "2026-07-04" // 测试统一对账日；订单 createdAt 落在该 UTC 窗口

beforeAll(async () => {
  await seedConfigs()
  userId = await makeLedgerUser((id) => madeUsers.push(id))
})

afterAll(async () => {
  // 差异表无 FK：显式清掉本测试产生的 diff（按 orderId/userId 双口径）
  if (madeOrders.length) await getDb().delete(reconcileDiffs).where(inArray(reconcileDiffs.orderId, madeOrders))
  await getDb().delete(reconcileDiffs).where(inArray(reconcileDiffs.userId, madeUsers))
  for (const id of madeUsers) await getDb().delete(users).where(eq(users.id, id))
  await closeDb()
})

/** 直插订单（避开 createOrder 的开放单频控；对账测试要精确控制字段）。 */
async function mkOrder(status: string, amountCents: number, extra: Partial<typeof paymentOrders.$inferInsert> = {}) {
  const [o] = await getDb()
    .insert(paymentOrders)
    .values({
      userId,
      type: "recharge",
      amountCents,
      status,
      clientSn: `rc-${randomUUID()}`,
      idempotencyKey: `rc-${randomUUID()}`,
      createdAt: new Date(`${BILL_DATE}T08:00:00.000Z`), // 落在对账日窗口
      ...extra,
    })
    .returning()
  madeOrders.push(o!.id)
  return o!
}

/** 按 clientSn 返回可控查询结果；未配置的 clientSn 返回 pending（不产生差异）。 */
function mockProvider(results: Record<string, Awaited<ReturnType<ReconcileProvider["query"]>> | Error>): ReconcileProvider {
  return {
    query: async (clientSn: string) => {
      const r = results[clientSn]
      if (r instanceof Error) throw r
      return r ?? { status: "pending" }
    },
  }
}

const diffsOf = (orderId: string) => getDb().select().from(reconcileDiffs).where(eq(reconcileDiffs.orderId, orderId))

describe("spec306 对账（只读核对，差异落表幂等）", () => {
  it("金额不符 → amount_mismatch（本地 1000 vs 通道 999）", async () => {
    const o = await mkOrder("paid", 1000, { providerTradeNo: "T-am" })
    await runReconcile(BILL_DATE, {
      provider: mockProvider({ [o.clientSn]: { status: "paid", totalAmountCents: 999, sn: "T-am" } }),
      alertHook: () => {},
    })
    const rows = await diffsOf(o.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.diffType).toBe("amount_mismatch")
    expect(rows[0]!.localValue).toBe("1000")
    expect(rows[0]!.billValue).toBe("999")
  })

  it("状态不符 → status_mismatch（本地 paid，通道 failed）", async () => {
    const o = await mkOrder("paid", 500, { providerTradeNo: "T-sm" })
    await runReconcile(BILL_DATE, {
      provider: mockProvider({ [o.clientSn]: { status: "failed", totalAmountCents: 500 } }),
      alertHook: () => {},
    })
    const rows = await diffsOf(o.id)
    expect(rows.map((r) => r.diffType)).toContain("status_mismatch")
  })

  it("unknown 清算：通道已付 → unknown_paid 差异；通道明确失败 → 订单收敛 failed", async () => {
    const oPaid = await mkOrder("unknown", 300)
    const oFail = await mkOrder("unknown", 400)
    await runReconcile(BILL_DATE, {
      provider: mockProvider({
        [oPaid.clientSn]: { status: "paid", totalAmountCents: 300, sn: "S-up" },
        [oFail.clientSn]: { status: "failed" },
      }),
      alertHook: () => {},
    })
    expect((await diffsOf(oPaid.id)).map((r) => r.diffType)).toContain("unknown_paid")
    const [f] = await getDb().select().from(paymentOrders).where(eq(paymentOrders.id, oFail.id))
    expect(f!.status).toBe("failed") // 对账唯一允许的订单写动作
    expect(await diffsOf(oFail.id)).toHaveLength(0)
  })

  it("本地已结算而通道查无（业务级拒绝）→ provider_missing；网络类异常跳过不落差异", async () => {
    const oMissing = await mkOrder("paid", 300, { providerTradeNo: "T-pm" })
    const oNet = await mkOrder("paid", 300, { providerTradeNo: "T-net" })
    await runReconcile(BILL_DATE, {
      provider: mockProvider({
        [oMissing.clientSn]: new Error("收钱吧查询失败: ORDER_NOT_EXIST"),
        [oNet.clientSn]: new Error("收钱吧网关 HTTP 502: /upay/v2/query"),
      }),
      alertHook: () => {},
    })
    expect((await diffsOf(oMissing.id)).map((r) => r.diffType)).toContain("provider_missing")
    expect(await diffsOf(oNet.id)).toHaveLength(0) // 网络抖动：下轮重试，不误报单边账
  })

  it("对账一致 → 无差异；重复跑幂等不重复落 diff", async () => {
    const o = await mkOrder("paid", 800, { providerTradeNo: "T-ok" })
    const deps = {
      provider: mockProvider({ [o.clientSn]: { status: "paid", totalAmountCents: 800, sn: "T-ok" } }),
      alertHook: () => {},
    }
    await runReconcile(BILL_DATE, deps)
    expect(await diffsOf(o.id)).toHaveLength(0)

    const oBad = await mkOrder("paid", 1000, { providerTradeNo: "T-idem" })
    const badDeps = {
      provider: mockProvider({
        [o.clientSn]: { status: "paid", totalAmountCents: 800, sn: "T-ok" },
        [oBad.clientSn]: { status: "paid", totalAmountCents: 1, sn: "T-idem" },
      }),
      alertHook: () => {},
    }
    await runReconcile(BILL_DATE, badDeps)
    await runReconcile(BILL_DATE, badDeps) // 重复跑
    expect(await diffsOf(oBad.id)).toHaveLength(1) // 同 (日,主体,类型) 只落一条
  })
})

describe("spec306 账本审计（缓存余额 vs Σ流水）", () => {
  it("缓存被写错 → ledger_mismatch + 返回不一致项；缓存正确不误报", async () => {
    const badUser = await makeLedgerUser((id) => madeUsers.push(id))
    await grant(badUser, 100, { idempotencyKey: `al-${badUser}` })
    await getDb().update(creditBalances).set({ balance: 80 }).where(eq(creditBalances.userId, badUser)) // 故意写错

    const goodUser = await makeLedgerUser((id) => madeUsers.push(id))
    await grant(goodUser, 50, { idempotencyKey: `al-${goodUser}` })

    const bad = await auditLedger(BILL_DATE, () => {})
    const mine = bad.filter((b) => b.userId === badUser || b.userId === goodUser)
    expect(mine).toEqual([{ userId: badUser, cached: 80, actual: 100 }])
    const rows = await getDb()
      .select()
      .from(reconcileDiffs)
      .where(and(eq(reconcileDiffs.userId, badUser), eq(reconcileDiffs.diffType, "ledger_mismatch")))
    expect(rows).toHaveLength(1)
  })
})

describe("spec306 孤儿 hold 清扫（spec302 C1：进程被杀冻结的预扣自动退还）", () => {
  it("超时无了结的 hold → 自动 release 退还 + 落 orphan_hold；已了结/新鲜的 hold 不动", async () => {
    const u = await makeLedgerUser((id) => madeUsers.push(id))
    await grant(u, 30, { idempotencyKey: `oh-${u}` })
    // 孤儿：hold 后无了结，且已超 24h（回拨 createdAt 模拟）
    const { holdId: orphan } = await hold(u, "read", { idempotencyKey: `oh-h1-${u}` })
    await getDb()
      .update(creditTransactions)
      .set({ createdAt: new Date(Date.now() - 25 * 3600_000) })
      .where(eq(creditTransactions.id, orphan))
    // 已了结：hold + settle（同样回拨，不该被清扫）
    const { holdId: settled } = await hold(u, "read", { idempotencyKey: `oh-h2-${u}` })
    await settle(settled, 10, { idempotencyKey: `oh-s2-${u}` })
    await getDb()
      .update(creditTransactions)
      .set({ createdAt: new Date(Date.now() - 25 * 3600_000) })
      .where(eq(creditTransactions.id, settled))
    // 新鲜在途：不该被清扫
    await hold(u, "read", { idempotencyKey: `oh-h3-${u}` })

    const before = await getBalance(u) // 30 - 10(孤儿) - 10(已结) - 10(在途) = 0
    expect(before).toBe(0)
    const released = await releaseOrphanHolds(new Date(), { alertHook: () => {} })
    expect(released).toBeGreaterThanOrEqual(1)
    expect(await getBalance(u)).toBe(10) // 只有孤儿被退还 +10

    const rows = await getDb()
      .select()
      .from(reconcileDiffs)
      .where(and(eq(reconcileDiffs.userId, u), eq(reconcileDiffs.diffType, "orphan_hold")))
    expect(rows).toHaveLength(1)

    await releaseOrphanHolds(new Date(), { alertHook: () => {} }) // 重复跑幂等
    expect(await getBalance(u)).toBe(10)
  })
})
