import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { randomUUID } from "node:crypto"
import { eq, inArray } from "drizzle-orm"
import { getDb, closeDb } from "../src/db/client"
import { users, paymentOrders, reconcileDiffs } from "../src/db/schema"
import { expireCreditsJob, reconcileJob } from "../src/crons/billing"
import { grant, getBalance } from "../src/services/credits"
import { seedConfigs } from "../src/services/config"
import { makeLedgerUser, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/billing-crons.test.ts）

const madeUsers: string[] = []
const madeOrders: string[] = []

beforeAll(async () => {
  await seedConfigs()
})

afterAll(async () => {
  if (madeOrders.length) await getDb().delete(reconcileDiffs).where(inArray(reconcileDiffs.orderId, madeOrders))
  for (const id of madeUsers) await getDb().delete(users).where(eq(users.id, id))
  await closeDb()
})

describe("spec306 计费 Cron job 体（直调，不依赖 Redis/定时器）", () => {
  it("expireCreditsJob：到期批次被注销（spec302 expireDue 薄封装）", async () => {
    const userId = await makeLedgerUser((id) => madeUsers.push(id))
    await grant(userId, 50, { idempotencyKey: `ec-${userId}`, expireAt: new Date(Date.now() - 86400_000) })
    expect(await getBalance(userId)).toBe(50)
    await expireCreditsJob()
    expect(await getBalance(userId)).toBe(0) // 过期注销
  })

  it("reconcileJob：对昨日账 + 账本审计 + 孤儿清扫一起跑，差异触发 alertHook", async () => {
    const userId = await makeLedgerUser((id) => madeUsers.push(id))
    // 昨日窗口内的金额不符订单
    const [o] = await getDb()
      .insert(paymentOrders)
      .values({
        userId,
        type: "recharge",
        amountCents: 1000,
        status: "paid",
        clientSn: `bc-${randomUUID()}`,
        idempotencyKey: `bc-${randomUUID()}`,
        providerTradeNo: `T-${randomUUID().slice(0, 8)}`,
        createdAt: new Date(Date.now() - 86400_000),
      })
      .returning()
    madeOrders.push(o!.id)

    let alerts = 0
    await reconcileJob({
      // 只对本测试的单返回金额不符；其他（共享库遗留）一律 pending 不产生差异
      provider: { query: async (sn) => (sn === o!.clientSn ? { status: "paid", totalAmountCents: 999, sn: "T-bc" } : { status: "pending" }) },
      alertHook: () => {
        alerts++
      },
    })
    expect(alerts).toBeGreaterThan(0) // 金额不符触发告警
    const rows = await getDb().select().from(reconcileDiffs).where(eq(reconcileDiffs.orderId, o!.id))
    expect(rows.map((r) => r.diffType)).toContain("amount_mismatch")
  })
})
