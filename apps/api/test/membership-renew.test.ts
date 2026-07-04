import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { createSign, generateKeyPairSync } from "node:crypto"
import { eq, inArray } from "drizzle-orm"
import { Hono } from "hono"
import { membershipRoutes } from "../src/routes/membership"
import { paymentRoutes } from "../src/routes/payment"
import { makeShouqianbaProvider } from "../src/services/payment/shouqianba"
import { loginWithPhone } from "../src/services/auth"
import { seedConfigs } from "../src/services/config"
import { getDb, closeDb } from "../src/db/client"
import { users, plans, subscriptions, paymentOrders, creditTransactions } from "../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/membership-renew.test.ts）

let token = ""
let userId = ""
let planId = ""
let zeroPlanId = ""
const madePlans: string[] = []
const polled: string[] = []

// 真 provider（真 RSA 验签/解析）；notify 路由同挂，测「下单 → 回调 → 续期」全链路
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const provider = makeShouqianbaProvider({
  cfg: {
    gateway: "https://sqb.test",
    wapGateway: "https://wap.test/gateway",
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  },
  getCredentials: async () => ({ terminalSn: "TSN-MB", terminalKey: "tkey-mb" }),
})
const signOf = (body: string) => createSign("RSA-SHA256").update(body, "utf8").sign(privateKey, "base64")

const app = new Hono()
const deps = { provider, baseUrl: "https://app.test", poll: (id: string) => void polled.push(id) }
app.route("/api/membership", membershipRoutes(deps))
app.route("/api/payment", paymentRoutes(deps))

beforeAll(async () => {
  await seedConfigs()
  const a = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  token = a.token
  userId = a.user.id
  const inserted = await getDb()
    .insert(plans)
    .values([
      { name: "测试月卡-route", priceCents: 2000, billingCycle: "month", grantCreditsPerCycle: 200 },
      { name: "未定价套餐", priceCents: 0, billingCycle: "month" },
    ])
    .returning()
  planId = inserted[0]!.id
  zeroPlanId = inserted[1]!.id
  madePlans.push(...inserted.map((p) => p.id))
})

afterAll(async () => {
  await getDb().delete(users).where(eq(users.id, userId))
  await getDb().delete(plans).where(inArray(plans.id, madePlans))
  await closeDb()
})

const auth = { Authorization: () => ({ Authorization: `Bearer ${token}`, "content-type": "application/json" }) }
const orderRow = async (id: string) => (await getDb().select().from(paymentOrders).where(eq(paymentOrders.id, id)))[0]

describe("POST /api/membership/renew（服务端定价，复用 spec304 支付链路）", () => {
  it("未登录 401；非法/不存在 planId 400", async () => {
    expect((await app.request("/api/membership/renew", { method: "POST", body: "{}" })).status).toBe(401)
    const bad = await app.request("/api/membership/renew", {
      method: "POST",
      headers: auth.Authorization(),
      body: JSON.stringify({ planId: "not-a-uuid" }),
    })
    expect(bad.status).toBe(400)
  })

  it("套餐未定价（priceCents=0）→ 500 拒绝下单（宁可失败不可错价收钱）", async () => {
    const res = await app.request("/api/membership/renew", {
      method: "POST",
      headers: auth.Authorization(),
      body: JSON.stringify({ planId: zeroPlanId }),
    })
    expect(res.status).toBe(500)
  })

  it("下单：服务端取价快照 + planId 落单 + payUrl + 启动轮询；客户端假金额被忽略", async () => {
    const res = await app.request("/api/membership/renew", {
      method: "POST",
      headers: auth.Authorization(),
      body: JSON.stringify({ planId, amountCents: 1, priceCents: 1 }), // 恶意字段应被忽略
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { orderId: string; payUrl: string }
    expect(body.payUrl).toContain("https://wap.test/gateway")
    const row = await orderRow(body.orderId)
    expect(row!.type).toBe("renewal")
    expect(row!.amountCents).toBe(2000) // plans 当前价快照
    expect(row!.planId).toBe(planId)
    expect(row!.cycleSnapshot).toBe("month") // 权益快照：周期
    expect(row!.creditsSnapshot).toBe(200) // 权益快照：当期积分
    expect(polled).toContain(body.orderId)
  })

  it("全链路：下单 → 收钱吧 PAID 回调 → 续期 + 发当期积分恰好一次（重复回调不重复）", async () => {
    const res = await app.request("/api/membership/renew", {
      method: "POST",
      headers: auth.Authorization(),
      body: JSON.stringify({ planId }),
    })
    const { orderId } = (await res.json()) as { orderId: string }
    const clientSn = (await orderRow(orderId))!.clientSn

    const cb = JSON.stringify({ client_sn: clientSn, order_status: "PAID", sn: "sqb-mb1", total_amount: "2000" })
    const fire = () =>
      app.request("/api/payment/shouqianba/notify", { method: "POST", headers: { Authorization: signOf(cb) }, body: cb })

    expect((await fire()).status).toBe(200)
    expect((await orderRow(orderId))!.status).toBe("paid")
    const [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.userId, userId))
    expect(sub!.status).toBe("active")
    expect(sub!.planId).toBe(planId)
    expect(sub!.currentPeriodEnd!.getTime()).toBeGreaterThan(Date.now() + 27 * 86_400_000) // ≈+1 自然月
    const grants = await getDb()
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.idempotencyKey, `renewal:${orderId}`))
    expect(grants).toHaveLength(1)
    expect(grants[0]!.amount).toBe(200)

    expect((await fire()).status).toBe(200) // 收钱吧重发
    const after = await getDb()
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.idempotencyKey, `renewal:${orderId}`))
    expect(after).toHaveLength(1) // 不重复发放
    expect((await getDb().select().from(subscriptions).where(eq(subscriptions.userId, userId)))[0]!.currentPeriodEnd!.getTime()).toBe(
      sub!.currentPeriodEnd!.getTime(), // 不重复续期
    )
  })
})

// 放在最后：本用例会把该用户的开放单配额打满
describe("开放订单上限（防刷单/网关放大）", () => {
  it("created 单达到上限后继续下单 → 429", async () => {
    let got429 = false
    for (let i = 0; i < 8 && !got429; i++) {
      const res = await app.request("/api/membership/renew", {
        method: "POST",
        headers: auth.Authorization(),
        body: JSON.stringify({ planId }),
      })
      if (res.status === 429) got429 = true
      else expect(res.status).toBe(200)
    }
    expect(got429).toBe(true) // 上限 5：最多 8 次内必触发
  })
})
