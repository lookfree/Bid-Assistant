import { describe, it, expect, afterAll, setDefaultTimeout } from "bun:test"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { adminRoutes } from "../src/routes/admin"
import { listOrders, getOrderDetail } from "../src/services/admin/admin-orders"
import { getDb, closeDb } from "../src/db/client"
import { users, adminUsers, paymentOrders, refunds, adminAuditLogs, plans } from "../src/db/schema"
import { makeUserWithNickname, makeAdminSession, createTestUser, uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/admin-orders.test.ts）

// 退款注入 mock provider（通道成功），避免打真实收钱吧
const app = new Hono()
app.route("/admin-api", adminRoutes({ resolveRefundProvider: () => ({ refund: async () => ({ ok: true }) }) }))
const madeUsers: string[] = []
const madeAdmins: string[] = []
const madePlans: string[] = []
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
  for (const id of madePlans) await getDb().delete(plans).where(eq(plans.id, id))
  for (const id of madeAdmins) await getDb().delete(adminUsers).where(eq(adminUsers.id, id))
  await closeDb()
})

// 订单页此前只有「类型/金额/状态/时间」，会员订单看不出开通的是哪个套餐、买了多久——
// plan_id 是 UUID、cycle_snapshot 压根没往前端送，运营只能去库里查。
describe("spec310 订单列表带套餐与周期", () => {
  it("会员订单回套餐名与计费周期（plan_id 是 UUID，运营看不懂）", async () => {
    const u = await makeUserWithNickname(regU)
    const [plan] = await getDb().insert(plans).values({ name: "专业版", billingCycle: "month" }).returning()
    madePlans.push(plan!.id)
    const [o] = await getDb()
      .insert(paymentOrders)
      .values({
        userId: u, type: "renewal", amountCents: 3900, status: "paid",
        planId: plan!.id, cycleSnapshot: "month", creditsSnapshot: 1200,
        clientSn: `t-${randomUUID()}`, idempotencyKey: `ord-${randomUUID()}`,
      })
      .returning()

    const res = await listOrders({ userId: u, page: 1, pageSize: 20 })
    const row = res.items.find((r) => r.id === o!.id)!
    expect(row.planName).toBe("专业版")
    expect(row.cycleSnapshot).toBe("month")
    expect(row.creditsSnapshot).toBe(1200)
  })

  it("充值订单没有套餐 → planName 为 null，不编造", async () => {
    const u = await makeUserWithNickname(regU)
    const o = await paidOrder(u, 100)
    const res = await listOrders({ userId: u, page: 1, pageSize: 20 })
    expect(res.items.find((r) => r.id === o.id)!.planName).toBeNull()
  })
})

// 退款时运营要先确认「这笔是谁的」。列表此前只有 user_id（UUID），核对得去用户页反查，
// 一单一查很容易退错人。展示名口径与账本页/用户选择器一致（userDisplayName）。
describe("订单列表带用户展示名", () => {
  it("有昵称 → 用昵称", async () => {
    const u = await makeUserWithNickname(regU, `退款测试_${Date.now().toString(36)}`)
    const o = await paidOrder(u)
    const res = await listOrders({ userId: u, page: 1, pageSize: 20 })
    expect(res.items.find((r) => r.id === o.id)!.userName).toMatch(/^退款测试_/)
  })

  it("无昵称 → 回落打码手机号（不是裸 UUID，也不泄露完整号码）", async () => {
    const phone = uniquePhone()
    const user = await createTestUser(phone)
    regU(user.id)
    const o = await paidOrder(user.id)
    const res = await listOrders({ userId: user.id, page: 1, pageSize: 20 })
    const name = res.items.find((r) => r.id === o.id)!.userName
    expect(name).toBe(`${phone.slice(0, 3)}****${phone.slice(-4)}`)
    expect(name).not.toBe(user.id)
  })

  it("全量视图下不同用户显示不同名字（同页混排也分得清）", async () => {
    const a = await makeUserWithNickname(regU)
    const b = await makeUserWithNickname(regU)
    const oa = await paidOrder(a)
    const ob = await paidOrder(b)
    const res = await listOrders({ page: 1, pageSize: 200 })
    const mine = res.items.filter((r) => r.id === oa.id || r.id === ob.id)
    expect(mine).toHaveLength(2)
    expect(new Set(mine.map((r) => r.userName)).size).toBe(2)
  })
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
