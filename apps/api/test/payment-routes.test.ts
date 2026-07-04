import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import { paymentRoutes } from "../src/routes/payment"
import { createOrder } from "../src/services/payment-orders"
import { loginWithPhone } from "../src/services/auth"
import { seedConfigs, setConfig } from "../src/services/config"
import { getDb, closeDb } from "../src/db/client"
import { users, paymentOrders, creditTransactions } from "../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"
import { makeSignedProvider } from "./helpers/sqb-gateway"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/payment-routes.test.ts）

let token = ""
let userId = ""
let otherToken = ""
let otherUserId = ""
const polled: string[] = []

// 真 ShouqianbaProvider + RSA 签名器（共享 helper：路由测试走生产解析/验签路径，不手抄 mock）
const { provider, signOf } = makeSignedProvider("RT")

const app = new Hono()
app.route("/api/payment", paymentRoutes({ provider, baseUrl: "https://app.test", poll: (id) => void polled.push(id) }))

beforeAll(async () => {
  await seedConfigs() // recharge_packs 等占位配置
  const a = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  token = a.token
  userId = a.user.id
  const b = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  otherToken = b.token
  otherUserId = b.user.id
})

afterAll(async () => {
  await getDb().delete(users).where(eq(users.id, userId))
  await getDb().delete(users).where(eq(users.id, otherUserId))
  await closeDb()
})

const auth = (t: string) => ({ Authorization: `Bearer ${t}`, "content-type": "application/json" })
const orderRow = async (id: string) => (await getDb().select().from(paymentOrders).where(eq(paymentOrders.id, id)))[0]
const grantCount = async (orderId: string) =>
  (
    await getDb()
      .select()
      .from(creditTransactions)
      .where(and(eq(creditTransactions.idempotencyKey, `purchase:${orderId}`)))
  ).length

describe("POST /api/payment/recharge", () => {
  it("未登录 401", async () => {
    const res = await app.request("/api/payment/recharge", { method: "POST", body: "{}" })
    expect(res.status).toBe(401)
  })

  it("非法 packId → 400（服务端定价，不认客户端金额）", async () => {
    const res = await app.request("/api/payment/recharge", {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ packId: "no-such-pack" }),
    })
    expect(res.status).toBe(400)
  })

  it("recharge_packs 配置非法（积分非正整数）→ 500 拒绝下单（宁可下单失败，不可收钱不发积分）", async () => {
    await setConfig("recharge_packs", [{ id: "pack_bad", amountCents: 100, credits: 0 }])
    const res = await app.request("/api/payment/recharge", {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ packId: "pack_bad" }),
    })
    expect(res.status).toBe(500)
    await setConfig("recharge_packs", [
      { id: "pack_100", amountCents: 100, credits: 100 },
      { id: "pack_1000", amountCents: 1000, credits: 1100 },
    ]) // 还原种子值
  })

  it("命中充值包 → 建单（金额/积分快照）+ 返回 payUrl + 启动后台轮询；客户端金额字段被忽略", async () => {
    const res = await app.request("/api/payment/recharge", {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ packId: "pack_100", amountCents: 1, credits: 99999 }), // 恶意字段应被忽略
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { orderId: string; payUrl: string }
    expect(body.payUrl).toContain("https://wap.test/gateway")
    const row = await orderRow(body.orderId)
    expect(row!.userId).toBe(userId)
    expect(row!.type).toBe("recharge")
    expect(row!.amountCents).toBe(100) // 服务端从配置取的快照
    expect(row!.creditsSnapshot).toBe(100)
    expect(row!.status).toBe("created")
    expect(polled).toContain(body.orderId) // 回调+轮询双通道
  })
})

describe("POST /api/payment/shouqianba/notify（无鉴权，验签放行）", () => {
  const notifyBody = (clientSn: string, totalAmount: string) =>
    JSON.stringify({ client_sn: clientSn, order_status: "PAID", sn: "sqb-n1", trade_no: "wx-n1", payway: "3", total_amount: totalAmount })

  it("验签失败 403，不改任何状态", async () => {
    const o = await createOrder({ userId, type: "recharge", amountCents: 100, creditsSnapshot: 100, idempotencyKey: `rt-${userId}-n1` })
    const res = await app.request("/api/payment/shouqianba/notify", {
      method: "POST",
      headers: { Authorization: "BAD-SIGN" }, // 非法签名，真 RSA 验签必拒
      body: notifyBody((await orderRow(o.id))!.clientSn, "100"),
    })
    expect(res.status).toBe(403)
    expect((await orderRow(o.id))!.status).toBe("created")
    expect(await grantCount(o.id)).toBe(0)
  })

  it("验签通过但金额与订单不符 → 不入账、置 unknown 进对账队列，返回 200 停止重发", async () => {
    const o = await createOrder({ userId, type: "recharge", amountCents: 100, creditsSnapshot: 100, idempotencyKey: `rt-${userId}-n2` })
    const body = notifyBody((await orderRow(o.id))!.clientSn, "1")
    const res = await app.request("/api/payment/shouqianba/notify", {
      method: "POST",
      headers: { Authorization: signOf(body) },
      body,
    })
    expect(res.status).toBe(200)
    expect((await orderRow(o.id))!.status).toBe("unknown") // spec306 对账扫 unknown；留 created 对账扫不到
    expect(await grantCount(o.id)).toBe(0)
  })

  it("验签通过但缺 total_amount → 不入账（金额铁律：必须校验，不是有金额才校验）", async () => {
    const o = await createOrder({ userId, type: "recharge", amountCents: 100, creditsSnapshot: 100, idempotencyKey: `rt-${userId}-n2b` })
    const body = JSON.stringify({ client_sn: (await orderRow(o.id))!.clientSn, order_status: "PAID", sn: "sqb-nb" })
    const res = await app.request("/api/payment/shouqianba/notify", {
      method: "POST",
      headers: { Authorization: signOf(body) },
      body,
    })
    expect(res.status).toBe(200)
    expect((await orderRow(o.id))!.status).toBe("unknown")
    expect(await grantCount(o.id)).toBe(0)
  })

  it("验签+金额通过 → paid + grant 一次；重复 notify 不重复 grant", async () => {
    const o = await createOrder({ userId, type: "recharge", amountCents: 100, creditsSnapshot: 100, idempotencyKey: `rt-${userId}-n3` })
    const clientSn = (await orderRow(o.id))!.clientSn
    const body = notifyBody(clientSn, "100")
    const fire = () =>
      app.request("/api/payment/shouqianba/notify", { method: "POST", headers: { Authorization: signOf(body) }, body })

    const res1 = await fire()
    expect(res1.status).toBe(200)
    const row = await orderRow(o.id)
    expect(row!.status).toBe("paid")
    expect(row!.providerTradeNo).toBe("sqb-n1")
    expect(await grantCount(o.id)).toBe(1)

    const res2 = await fire() // 收钱吧重发
    expect(res2.status).toBe(200)
    expect(await grantCount(o.id)).toBe(1) // 仍只一次
  })

  it("未知 client_sn → 404（非我方订单的回调不吞成 200）", async () => {
    const body = notifyBody("bid-not-exists", "100")
    const res = await app.request("/api/payment/shouqianba/notify", {
      method: "POST",
      headers: { Authorization: signOf(body) },
      body,
    })
    expect(res.status).toBe(404)
  })
})

describe("GET /api/payment/orders/:id", () => {
  it("本人可查状态；他人 404", async () => {
    const o = await createOrder({ userId, type: "recharge", amountCents: 100, creditsSnapshot: 100, idempotencyKey: `rt-${userId}-g1` })
    const res = await app.request(`/api/payment/orders/${o.id}`, { headers: auth(token) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string; status: string; amountCents: number }
    expect(body.id).toBe(o.id)
    expect(body.status).toBe("created")
    expect(body.amountCents).toBe(100)

    const other = await app.request(`/api/payment/orders/${o.id}`, { headers: auth(otherToken) })
    expect(other.status).toBe(404)
  })
})
