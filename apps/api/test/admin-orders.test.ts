import { describe, it, expect, afterAll, setDefaultTimeout } from "bun:test"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { adminRoutes } from "../src/routes/admin"
import { listOrders, getOrderDetail } from "../src/services/admin/admin-orders"
import { getDb, closeDb } from "../src/db/client"
import { users, adminUsers, paymentOrders, refunds, adminAuditLogs } from "../src/db/schema"
import { makeUserWithNickname, makeAdminSession, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/admin-orders.test.ts）

// 退款注入 mock provider（通道成功），避免打真实收钱吧
const app = new Hono()
app.route("/admin-api", adminRoutes({ resolveRefundProvider: () => ({ refund: async () => ({ ok: true }) }) }))
const madeUsers: string[] = []
const madeAdmins: string[] = []
const regU = (id: string) => madeUsers.push(id)
const regA = (id: string) => madeAdmins.push(id)

async function paidOrder(userId: string, amountCents = 1000) {
  const [o] = await getDb()
    .insert(paymentOrders)
    .values({ userId, type: "recharge", amountCents, status: "paid", clientSn: `t-${randomUUID()}`, idempotencyKey: `ord-${randomUUID()}` })
    .returning()
  return o!
}

afterAll(async () => {
  for (const id of madeUsers) await getDb().delete(users).where(eq(users.id, id))
  for (const id of madeAdmins) await getDb().delete(adminUsers).where(eq(adminUsers.id, id))
  await closeDb()
})

describe("spec310 订单页", () => {
  it("列表 + 状态过滤 + 分页", async () => {
    const u = await makeUserWithNickname(regU)
    await paidOrder(u)
    const r = await listOrders({ status: "paid", userId: u, page: 1, pageSize: 10 })
    expect(r.items.every((o) => o.status === "paid")).toBe(true)
    expect(r.total).toBeGreaterThanOrEqual(1)
  })

  it("详情含关联退款", async () => {
    const u = await makeUserWithNickname(regU)
    const o = await paidOrder(u)
    await getDb().insert(refunds).values({ orderId: o.id, amountCents: 1000, status: "done", operator: "ops" })
    const d = await getOrderDetail(o.id)
    expect(d.refunds.length).toBe(1)
  })

  it("finance 发起退款 → done + 审计；support → 403", async () => {
    const u = await makeUserWithNickname(regU)
    const o = await paidOrder(u)
    const fin = await makeAdminSession("finance", regA)
    const ok = await app.request("http://x/admin-api/refunds", { method: "POST", headers: fin.headers, body: JSON.stringify({ orderId: o.id, amount: 1000, reason: "用户申请" }) })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { status: string }).status).toBe("done")
    const logs = await getDb().select().from(adminAuditLogs).where(eq(adminAuditLogs.target, `order:${o.id}`))
    expect(logs.some((l) => l.action === "refund.write")).toBe(true)

    const o2 = await paidOrder(u)
    const sup = await makeAdminSession("support", regA)
    const denied = await app.request("http://x/admin-api/refunds", { method: "POST", headers: sup.headers, body: JSON.stringify({ orderId: o2.id, amount: 1, reason: "x" }) })
    expect(denied.status).toBe(403)
  })
})
