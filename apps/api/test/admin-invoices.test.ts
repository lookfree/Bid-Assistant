import { describe, it, expect, afterAll, setDefaultTimeout } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import { Hono } from "hono"
import { randomUUID } from "node:crypto"
import { adminRoutes } from "../src/routes/admin"
import { createInvoiceRequest } from "../src/services/invoices"
import { createTestUser, uniquePhone, makeTestOrder, makeAdminSession, TEST_TIMEOUT_MS } from "./repos/helpers"
import { getDb, closeDb } from "../src/db/client"
import { users, adminUsers } from "../src/db/schema"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/admin-invoices.test.ts）

const app = new Hono()
app.route("/admin-api", adminRoutes())
const madeAdmins: string[] = []
const madeUsers: string[] = []
const regA = (id: string) => madeAdmins.push(id)

afterAll(async () => {
  await getDb().delete(adminUsers).where(inArray(adminUsers.id, madeAdmins))
  for (const id of madeUsers) await getDb().delete(users).where(eq(users.id, id)) // 级联删订单/发票
  await closeDb()
})

// 建一条 pending 发票（新用户 + 已支付订单 + 申请），返回其 id。
async function makeInvoice(): Promise<string> {
  const u = await createTestUser(uniquePhone())
  madeUsers.push(u.id)
  const order = await makeTestOrder(u.id, "paid", 6600)
  const inv = await createInvoiceRequest(u.id, { orderId: order.id, titleType: "personal", title: "测试", email: "a@b.com" })
  return inv.id
}

describe("spec332 发票管理（管理端 · invoice.write）", () => {
  it("ops 无 invoice.write → 403", async () => {
    const { headers } = await makeAdminSession("ops", regA)
    expect((await app.request("http://x/admin-api/invoices", { headers })).status).toBe(403)
  })

  it("finance 可列表 + 开具（issued 回填发票号）", async () => {
    const { headers } = await makeAdminSession("finance", regA)
    const id = await makeInvoice()
    expect((await app.request("http://x/admin-api/invoices?status=pending", { headers })).status).toBe(200)
    const res = await app.request(`http://x/admin-api/invoices/${id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ action: "issue", invoiceNo: "INV-001" }),
    })
    expect(res.status).toBe(200)
    const row = (await res.json()) as { status: string; invoiceNo: string }
    expect(row.status).toBe("issued")
    expect(row.invoiceNo).toBe("INV-001")
  })

  it("已开具再开 → 409 not_pending", async () => {
    const { headers } = await makeAdminSession("superadmin", regA)
    const id = await makeInvoice()
    await app.request(`http://x/admin-api/invoices/${id}`, { method: "PATCH", headers, body: JSON.stringify({ action: "issue", invoiceNo: "INV-002" }) })
    const again = await app.request(`http://x/admin-api/invoices/${id}`, { method: "PATCH", headers, body: JSON.stringify({ action: "issue", invoiceNo: "INV-003" }) })
    expect(again.status).toBe(409)
    expect(((await again.json()) as { error: string }).error).toBe("not_pending")
  })

  it("驳回 pending → rejected 记原因", async () => {
    const { headers } = await makeAdminSession("finance", regA)
    const id = await makeInvoice()
    const res = await app.request(`http://x/admin-api/invoices/${id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ action: "reject", reason: "抬头信息有误" }),
    })
    expect(res.status).toBe(200)
    const row = (await res.json()) as { status: string; rejectReason: string }
    expect(row.status).toBe("rejected")
    expect(row.rejectReason).toBe("抬头信息有误")
  })

  it("不存在的发票 id → 404", async () => {
    const { headers } = await makeAdminSession("superadmin", regA)
    const res = await app.request(`http://x/admin-api/invoices/${randomUUID()}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ action: "reject", reason: "x" }),
    })
    expect(res.status).toBe(404)
  })
})
