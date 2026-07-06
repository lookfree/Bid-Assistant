import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { and, eq, inArray } from "drizzle-orm"
import { getDb, closeDb } from "../src/db/client"
import { users, paymentOrders, reconcileDiffs, creditTransactions, creditBalances } from "../src/db/schema"
import { runReconcile, auditLedger, releaseOrphanHolds, type ReconcileProvider } from "../src/services/reconcile"
import { grant, hold, settle, getBalance } from "../src/services/credits"
import { seedConfigs } from "../src/services/config"
import { makeLedgerUser, makeTestOrder, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/reconcile.test.ts）

const madeUsers: string[] = []
const madeOrders: string[] = []
let userId = ""
const day = 86_400_000
const BILL_DATE = new Date().toISOString().slice(0, 10) // 对账日=今日 UTC（窗口向前含 7 天）

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

/** 默认建单于 2 天前：在 7 天对账窗内，且满足 unknown 收敛的 24h 账龄。 */
async function mkOrder(status: string, amountCents: number, extra: Partial<typeof paymentOrders.$inferInsert> = {}) {
  const o = await makeTestOrder(userId, status, amountCents, { createdAt: new Date(Date.now() - 2 * day), ...extra })
  madeOrders.push(o.id)
  return o
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
const quiet = () => {}

describe("spec306 对账（只读核对，差异落表幂等）", () => {
  it("金额不符 → amount_mismatch；晚结算单（建单在 7 天窗内非当日）也被扫到", async () => {
    const o = await mkOrder("paid", 1000, { providerTradeNo: "T-am", createdAt: new Date(Date.now() - 5 * day) }) // 5 天前建单
    await runReconcile(BILL_DATE, {
      provider: mockProvider({ [o.clientSn]: { status: "paid", totalAmountCents: 999, sn: "T-am" } }),
      alertHook: quiet,
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
      alertHook: quiet,
    })
    expect((await diffsOf(o.id)).map((r) => r.diffType)).toContain("status_mismatch")
  })

  it("本地 refunded 而通道仍 paid → status_mismatch（退款没到通道=单边账）；通道 refunded 则干净", async () => {
    const bad = await mkOrder("refunded", 500, { providerTradeNo: "T-rf-bad" })
    const ok = await mkOrder("refunded", 500, { providerTradeNo: "T-rf-ok" })
    await runReconcile(BILL_DATE, {
      provider: mockProvider({
        [bad.clientSn]: { status: "paid", totalAmountCents: 500 },
        [ok.clientSn]: { status: "refunded", totalAmountCents: 500 },
      }),
      alertHook: quiet,
    })
    expect((await diffsOf(bad.id)).map((r) => r.diffType)).toContain("status_mismatch")
    expect(await diffsOf(ok.id)).toHaveLength(0)
  })

  it("unknown 清算：通道已付 → unknown_paid；满 24h 且通道失败 → 收敛 failed；新鲜 unknown 不收敛（迟到回调留门）", async () => {
    const oPaid = await mkOrder("unknown", 300)
    const oFail = await mkOrder("unknown", 400) // 2 天前建单：满收敛账龄
    const oFresh = await mkOrder("unknown", 200, { createdAt: new Date() }) // 刚建：不收敛
    await runReconcile(BILL_DATE, {
      provider: mockProvider({
        [oPaid.clientSn]: { status: "paid", totalAmountCents: 300, sn: "S-up" },
        [oFail.clientSn]: { status: "failed" },
        [oFresh.clientSn]: { status: "failed" },
      }),
      alertHook: quiet,
    })
    expect((await diffsOf(oPaid.id)).map((r) => r.diffType)).toContain("unknown_paid")
    expect((await getDb().select().from(paymentOrders).where(eq(paymentOrders.id, oFail.id)))[0]!.status).toBe("failed")
    expect((await getDb().select().from(paymentOrders).where(eq(paymentOrders.id, oFresh.id)))[0]!.status).toBe("unknown") // 24h 内不关门
  })

  it("本地已结算而通道查无（业务级拒绝）→ provider_missing；网络类异常跳过不落差异", async () => {
    const oMissing = await mkOrder("paid", 300, { providerTradeNo: "T-pm" })
    const oNet = await mkOrder("paid", 300, { providerTradeNo: "T-net" })
    await runReconcile(BILL_DATE, {
      provider: mockProvider({
        [oMissing.clientSn]: new Error("收钱吧查询失败: ORDER_NOT_EXIST"),
        [oNet.clientSn]: new Error("收钱吧网关 HTTP 502: /upay/v2/query"),
      }),
      alertHook: quiet,
    })
    expect((await diffsOf(oMissing.id)).map((r) => r.diffType)).toContain("provider_missing")
    expect(await diffsOf(oNet.id)).toHaveLength(0) // 网络抖动：下轮重试，不误报单边账
  })

  it("持久差异不逐日重复落：同 (类型,主体) 只保留一行 open（换对账日重跑也不加行）", async () => {
    const o = await mkOrder("paid", 1000, { providerTradeNo: "T-idem" })
    const deps = {
      provider: mockProvider({ [o.clientSn]: { status: "paid", totalAmountCents: 1, sn: "T-idem" } }),
      alertHook: quiet,
    }
    await runReconcile(BILL_DATE, deps)
    await runReconcile(BILL_DATE, deps) // 同日重跑
    const nextDay = new Date(Date.now() + day).toISOString().slice(0, 10)
    await runReconcile(nextDay, deps) // 换日重跑（持久问题）
    expect(await diffsOf(o.id)).toHaveLength(1)
  }, TEST_TIMEOUT_MS * 2) // 连跑 3 次全表对账，远程 DB 高延迟下默认 20s 贴线，单独放宽
})

describe("spec306 账本审计（缓存余额 vs Σ流水，复查后落 diff）", () => {
  it("缓存被写错 → ledger_mismatch + 返回不一致项；缓存正确不误报", async () => {
    const badUser = await makeLedgerUser((id) => madeUsers.push(id))
    await grant(badUser, 100, { idempotencyKey: `al-${badUser}` })
    await getDb().update(creditBalances).set({ balance: 80 }).where(eq(creditBalances.userId, badUser)) // 故意写错

    const goodUser = await makeLedgerUser((id) => madeUsers.push(id))
    await grant(goodUser, 50, { idempotencyKey: `al-${goodUser}` })

    const bad = await auditLedger(BILL_DATE, quiet)
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
  it("超时无了结的 hold → 自动 release 退还 + 落 orphan_hold（subject=holdId）；已了结/新鲜的不动；重复跑幂等", async () => {
    const u = await makeLedgerUser((id) => madeUsers.push(id))
    await grant(u, 60, { idempotencyKey: `oh-${u}` })
    const { holdId: orphan } = await hold(u, "read", { idempotencyKey: `oh-h1-${u}` })
    await getDb()
      .update(creditTransactions)
      .set({ createdAt: new Date(Date.now() - 25 * 3600_000) })
      .where(eq(creditTransactions.id, orphan))
    const { holdId: settled } = await hold(u, "read", { idempotencyKey: `oh-h2-${u}` })
    await settle(settled, 20, { idempotencyKey: `oh-s2-${u}` })
    await getDb()
      .update(creditTransactions)
      .set({ createdAt: new Date(Date.now() - 25 * 3600_000) })
      .where(eq(creditTransactions.id, settled))
    await hold(u, "read", { idempotencyKey: `oh-h3-${u}` }) // 新鲜在途：不清扫

    expect(await getBalance(u)).toBe(0) // 60 - 20(孤儿) - 20(已结) - 20(在途)，read=20
    const released = await releaseOrphanHolds(new Date(), { alertHook: quiet })
    expect(released).toBeGreaterThanOrEqual(1)
    expect(await getBalance(u)).toBe(20) // 只有孤儿被退还

    const rows = await getDb()
      .select()
      .from(reconcileDiffs)
      .where(and(eq(reconcileDiffs.userId, u), eq(reconcileDiffs.diffType, "orphan_hold")))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.subject).toBe(orphan) // 主体=holdId：同人同日多个孤儿各留一行

    await releaseOrphanHolds(new Date(), { alertHook: quiet }) // 幂等：没有真实退还就不重复留痕
    expect(await getBalance(u)).toBe(20)
    expect(
      await getDb()
        .select()
        .from(reconcileDiffs)
        .where(and(eq(reconcileDiffs.userId, u), eq(reconcileDiffs.diffType, "orphan_hold"))),
    ).toHaveLength(1)
  })
})
