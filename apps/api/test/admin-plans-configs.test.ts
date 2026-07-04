import { describe, it, expect, afterAll, setDefaultTimeout } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import { Hono } from "hono"
import { adminRoutes } from "../src/routes/admin"
import { setConfig, getConfig } from "../src/services/config"
import { createPlan, updatePlan } from "../src/services/admin/admin-plans"
import { getDb, closeDb } from "../src/db/client"
import { plans, adminUsers, adminAuditLogs } from "../src/db/schema"
import { makeAdminSession, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/admin-plans-configs.test.ts）

const app = new Hono()
app.route("/admin-api", adminRoutes())
const madePlans: string[] = []
const madeAdmins: string[] = []
const regA = (id: string) => madeAdmins.push(id)

afterAll(async () => {
  await getDb().delete(plans).where(inArray(plans.id, madePlans))
  for (const id of madeAdmins) await getDb().delete(adminUsers).where(eq(adminUsers.id, id))
  await setConfig("credit_cost.read", 10) // 还原种子占位
  await closeDb()
})

describe("spec310 套餐&配置页", () => {
  it("改 billing_config：setConfig 纯写 + getConfig 立即读到新值（无缓存）", async () => {
    await setConfig("credit_cost.read", 10)
    expect(await getConfig<number>("credit_cost.read")).toBe(10)
    await setConfig("credit_cost.read", 25)
    expect(await getConfig<number>("credit_cost.read")).toBe(25)
  })

  it("config 审计在 route 层：PUT /plans/configs/:key 留前后值（ops 有 config.write）", async () => {
    await setConfig("credit_cost.read", 10)
    const { headers } = await makeAdminSession("ops", regA)
    const res = await app.request("http://x/admin-api/plans/configs/credit_cost.read", { method: "PUT", headers, body: JSON.stringify({ value: 25 }) })
    expect(res.status).toBe(200)
    expect(await getConfig<number>("credit_cost.read")).toBe(25)
    const logs = await getDb().select().from(adminAuditLogs).where(eq(adminAuditLogs.target, "config:credit_cost.read"))
    const last = logs.at(-1)!
    expect(last.before).toBe(10)
    expect(last.after).toBe(25)
  })

  it("复杂配置整体替换（recharge_packs）", async () => {
    await setConfig("recharge_packs", [{ amountCents: 100, credits: 100 }])
    await setConfig("recharge_packs", [{ amountCents: 1000, credits: 1200 }])
    expect(await getConfig<unknown[]>("recharge_packs")).toEqual([{ amountCents: 1000, credits: 1200 }])
  })

  it("plans CRUD：新建/改价 version 自增/下架 + 审计", async () => {
    const p = await createPlan({ name: "专业版", priceCents: 2900, billingCycle: "month", grantCreditsPerCycle: 1000 }, { operator: "ops_alice" })
    madePlans.push(p.id)
    expect(p.priceCents).toBe(2900)
    const upd = await updatePlan(p.id, { priceCents: 1900, status: "archived" }, { operator: "ops_alice" })
    expect(upd.priceCents).toBe(1900)
    expect(upd.status).toBe("archived")
    expect(upd.version).toBe((p.version ?? 1) + 1) // 改价 version 自增
    const logs = await getDb().select().from(adminAuditLogs).where(eq(adminAuditLogs.target, `plan:${p.id}`))
    expect(logs.length).toBeGreaterThanOrEqual(1)
  })

  it("support 改配置 → 403；support 改套餐 → 403", async () => {
    const { headers } = await makeAdminSession("support", regA)
    const cfg = await app.request("http://x/admin-api/plans/configs/credit_cost.read", { method: "PUT", headers, body: JSON.stringify({ value: 99 }) })
    expect(cfg.status).toBe(403)
    const pl = await app.request("http://x/admin-api/plans", { method: "POST", headers, body: JSON.stringify({ name: "x", billingCycle: "month" }) })
    expect(pl.status).toBe(403)
  })
})
