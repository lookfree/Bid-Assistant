import { describe, it, expect, afterAll, setDefaultTimeout } from "bun:test"
import { randomUUID } from "node:crypto"
import { eq, inArray } from "drizzle-orm"
import { Hono } from "hono"
import { adminRoutes } from "../src/routes/admin"
import { listDiffs, resolveDiff, fixUnknownPaid } from "../src/services/admin/diffs"
import { getDb, closeDb } from "../src/db/client"
import { users, adminUsers, paymentOrders, reconcileDiffs } from "../src/db/schema"
import { makeUserWithNickname, makeAdminSession, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/admin-diffs.test.ts）

const app = new Hono()
app.route("/admin-api", adminRoutes())
const madeUsers: string[] = []
const madeAdmins: string[] = []
const madeDiffs: string[] = []
const regU = (id: string) => madeUsers.push(id)
const regA = (id: string) => madeAdmins.push(id)

async function openDiff(diffType: string, subject: string, orderId?: string, tradeNo?: string) {
  const [d] = await getDb().insert(reconcileDiffs).values({ billDate: "2026-07-04", diffType, subject, orderId, tradeNo, resolved: "open" }).returning()
  madeDiffs.push(d!.id)
  return d!
}

afterAll(async () => {
  await getDb().delete(reconcileDiffs).where(inArray(reconcileDiffs.id, madeDiffs))
  for (const id of madeUsers) await getDb().delete(users).where(eq(users.id, id))
  for (const id of madeAdmins) await getDb().delete(adminUsers).where(eq(adminUsers.id, id))
  await closeDb()
})

describe("spec310 对账差异工作台", () => {
  it("列出 open 差异 + type 过滤", async () => {
    await openDiff("status_mismatch", `sub-${randomUUID()}`)
    const r = await listDiffs({ diffType: "status_mismatch", page: 1, pageSize: 50 })
    expect(r.items.every((d) => d.diffType === "status_mismatch" && d.resolved === "open")).toBe(true)
  })

  it("resolveDiff：置 resolved + 审计", async () => {
    const d = await openDiff("provider_missing", `sub-${randomUUID()}`)
    await resolveDiff(d.id, { operator: "finance_bob" })
    expect((await getDb().select().from(reconcileDiffs).where(eq(reconcileDiffs.id, d.id)))[0]!.resolved).toBe("resolved")
  })

  it("fixUnknownPaid：markPaid(allowStale) 补入账 + 关差异", async () => {
    const u = await makeUserWithNickname(regU)
    const [o] = await getDb()
      .insert(paymentOrders)
      .values({ userId: u, type: "recharge", amountCents: 1000, status: "unknown", creditsSnapshot: 100, clientSn: `t-${randomUUID()}`, idempotencyKey: `d-${randomUUID()}` })
      .returning()
    const d = await openDiff("unknown_paid", o!.id, o!.id, "T-sn")
    const res = await fixUnknownPaid(d.id, { operator: "finance_bob" })
    expect(res.paid).toBe(true)
    expect((await getDb().select().from(paymentOrders).where(eq(paymentOrders.id, o!.id)))[0]!.status).toBe("paid")
    expect((await getDb().select().from(reconcileDiffs).where(eq(reconcileDiffs.id, d.id)))[0]!.resolved).toBe("resolved")
  })

  it("非 unknown_paid 差异走修复入口 → 报错", async () => {
    const d = await openDiff("amount_mismatch", `sub-${randomUUID()}`)
    await expect(fixUnknownPaid(d.id, { operator: "x" })).rejects.toThrow()
  })

  it("support 处置差异 → 403（需 refund.write）", async () => {
    const d = await openDiff("status_mismatch", `sub-${randomUUID()}`)
    const { headers } = await makeAdminSession("support", regA)
    const res = await app.request(`http://x/admin-api/diffs/${d.id}/resolve`, { method: "PATCH", headers })
    expect(res.status).toBe(403)
  })
})
