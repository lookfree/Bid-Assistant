import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { invoiceRoutes } from "../src/routes/invoices"
import { createInvoiceRequest } from "../src/services/invoices"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, invoiceRequests } from "../src/db/schema"
import { uniquePhone, makeTestOrder, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/invoices.test.ts）

const app = new Hono()
app.route("/api/invoices", invoiceRoutes())
const auth = (t: string) => ({ Authorization: `Bearer ${t}`, "content-type": "application/json" })

let token = ""
let userId = ""
let otherUserId = ""

beforeAll(async () => {
  const a = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  token = a.token
  userId = a.user.id
  const b = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  otherUserId = b.user.id
})

afterAll(async () => {
  // 级联删用户 → 订单/发票一并清（userId FK 均 cascade）。
  await getDb().delete(users).where(eq(users.id, userId))
  await getDb().delete(users).where(eq(users.id, otherUserId))
  await closeDb()
})

describe("spec332 发票申请（C 端 · money-blind）", () => {
  it("未登录 → 401", async () => {
    expect((await app.request("/api/invoices", { method: "POST", body: "{}" })).status).toBe(401)
  })

  it("已支付订单可建 pending，金额取订单快照（不信客户端）", async () => {
    const order = await makeTestOrder(userId, "paid", 9900)
    const res = await app.request("/api/invoices", {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ orderId: order.id, titleType: "personal", title: "张三", email: "a@b.com", amountCents: 1 }),
    })
    expect(res.status).toBe(201)
    const row = (await res.json()) as { status: string; amountCents: number }
    expect(row.status).toBe("pending")
    expect(row.amountCents).toBe(9900)
  })

  it("非本人订单 → order_not_found", async () => {
    const order = await makeTestOrder(otherUserId, "paid", 5000)
    await expect(
      createInvoiceRequest(userId, { orderId: order.id, titleType: "personal", title: "x", email: "a@b.com" }),
    ).rejects.toMatchObject({ code: "order_not_found" })
  })

  it("未支付订单 → 400 order_not_paid", async () => {
    const order = await makeTestOrder(userId, "created", 5000)
    const res = await app.request("/api/invoices", {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ orderId: order.id, titleType: "personal", title: "x", email: "a@b.com" }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("order_not_paid")
  })

  it("企业抬头缺税号 → 400 tax_no_required", async () => {
    const order = await makeTestOrder(userId, "paid", 5000)
    const res = await app.request("/api/invoices", {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ orderId: order.id, titleType: "enterprise", title: "某公司", email: "a@b.com" }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("tax_no_required")
  })

  it("同一订单重复申请 → 409 invoice_exists；驳回后可重申", async () => {
    const order = await makeTestOrder(userId, "paid", 8000)
    const first = await createInvoiceRequest(userId, { orderId: order.id, titleType: "personal", title: "李四", email: "a@b.com" })
    await expect(
      createInvoiceRequest(userId, { orderId: order.id, titleType: "personal", title: "李四", email: "a@b.com" }),
    ).rejects.toMatchObject({ code: "invoice_exists" })
    // 驳回后部分唯一索引释放（不含 rejected）→ 可重新申请
    await getDb().update(invoiceRequests).set({ status: "rejected" }).where(eq(invoiceRequests.id, first.id))
    const again = await createInvoiceRequest(userId, { orderId: order.id, titleType: "personal", title: "李四", email: "a@b.com" })
    expect(again.status).toBe("pending")
  })

  it("列表只返回本人发票", async () => {
    const res = await app.request("/api/invoices", { headers: auth(token) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { userId: string }[] }
    expect(body.items.length).toBeGreaterThan(0)
    expect(body.items.every((i) => i.userId === userId)).toBe(true)
  })
})
