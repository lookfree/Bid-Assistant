import { describe, it, expect, afterAll, setDefaultTimeout } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import { Hono } from "hono"
import { adminRoutes } from "../src/routes/admin"
import { setConfig, getConfig } from "../src/services/config"
import { createPlan, updatePlan } from "../src/services/admin/admin-plans"
import { getDb, closeDb } from "../src/db/client"
import { plans, adminUsers, adminAuditLogs, billingConfigs } from "../src/db/schema"
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
  await setConfig("referral_rules", { inviterReward: 50, inviteeReward: 50, unlockOn: "invitee_first_paid", capPerUser: 500, riskMaxPerIpPerHour: 20, abandonDays: 0 }) // 还原种子占位
  await setConfig("reward_expire_days", 30) // 还原种子占位
  await getDb().delete(billingConfigs).where(eq(billingConfigs.key, "test_free_key"))
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

// spec327 Task A：两个钱相关配置键（referral_rules / reward_expire_days）加白名单形状校验，
// 其它键保持宽松直存（现行为不变）。权限 403 已在上面 "support 改配置 → 403" 覆盖，不重复。
describe("spec327 配置写入形状校验（钱相关键白名单）", () => {
  const BASELINE_RULES = { inviterReward: 10, inviteeReward: 10, unlockOn: "", capPerUser: 100, riskMaxPerIpPerHour: 5, abandonDays: 0 }
  const VALID_RULES = { inviterReward: 50, inviteeReward: 50, unlockOn: "invitee_first_paid", capPerUser: 500, riskMaxPerIpPerHour: 20, abandonDays: 7 }

  it("合法 referral_rules 六键 → 200，落库，审计带 before/after", async () => {
    await setConfig("referral_rules", BASELINE_RULES)
    const { headers } = await makeAdminSession("ops", regA)
    const res = await app.request("http://x/admin-api/plans/configs/referral_rules", {
      method: "PUT",
      headers,
      body: JSON.stringify({ value: VALID_RULES }),
    })
    expect(res.status).toBe(200)
    expect(await getConfig<typeof VALID_RULES>("referral_rules")).toEqual(VALID_RULES)
    const logs = await getDb().select().from(adminAuditLogs).where(eq(adminAuditLogs.target, "config:referral_rules"))
    const last = logs.at(-1)!
    expect(last.before).toEqual(BASELINE_RULES)
    expect(last.after).toEqual(VALID_RULES)
  })

  it("referral_rules 坏输入全部 400 invalid_input，库值不变", async () => {
    await setConfig("referral_rules", BASELINE_RULES)
    const { headers } = await makeAdminSession("ops", regA)
    const put = (value: unknown) =>
      app.request("http://x/admin-api/plans/configs/referral_rules", { method: "PUT", headers, body: JSON.stringify({ value }) })

    const { abandonDays: _drop, ...missingKey } = VALID_RULES
    const badCases: Record<string, unknown> = {
      缺键: missingKey,
      负数: { ...VALID_RULES, inviterReward: -1 },
      unlockOn非法枚举: { ...VALID_RULES, unlockOn: "bad_enum" },
      "capPerUser<max两奖励": { ...VALID_RULES, inviterReward: 100, inviteeReward: 100, capPerUser: 50 },
      非对象: "not-an-object",
      未知多余键: { ...VALID_RULES, extraKey: 1 },
    }
    for (const [label, bad] of Object.entries(badCases)) {
      const res = await put(bad)
      const body = (await res.json()) as { error?: string }
      if (res.status !== 400 || body.error !== "invalid_input") throw new Error(`case "${label}" 期望 400 invalid_input，实际 ${res.status} ${JSON.stringify(body)}`)
    }
    expect(await getConfig<typeof BASELINE_RULES>("referral_rules")).toEqual(BASELINE_RULES) // 全部拒绝，库值原封不动
  })

  it("reward_expire_days：合法非负整数 → 200；负数/小数/非数 → 400 且库值不变", async () => {
    await setConfig("reward_expire_days", 30)
    const { headers } = await makeAdminSession("ops", regA)
    const put = (value: unknown) =>
      app.request("http://x/admin-api/plans/configs/reward_expire_days", { method: "PUT", headers, body: JSON.stringify({ value }) })

    const ok = await put(60)
    expect(ok.status).toBe(200)
    expect(await getConfig<number>("reward_expire_days")).toBe(60)

    for (const bad of [-1, 1.5, "30"]) {
      const res = await put(bad)
      expect(res.status).toBe(400)
    }
    expect(await getConfig<number>("reward_expire_days")).toBe(60) // 坏值全部拒绝，维持上一次合法值
  })

  it("signup_grant_credits / grant_expire_days：合法非负整数 → 200；负数/小数/非数 → 400 且库值不变", async () => {
    const { headers } = await makeAdminSession("ops", regA)
    for (const key of ["signup_grant_credits", "grant_expire_days"]) {
      const put = (value: unknown) =>
        app.request(`http://x/admin-api/plans/configs/${key}`, { method: "PUT", headers, body: JSON.stringify({ value }) })
      const ok = await put(66)
      expect(ok.status).toBe(200)
      expect(await getConfig<number>(key)).toBe(66)
      for (const bad of [-1, 1.5, "30"]) {
        const res = await put(bad)
        expect(res.status).toBe(400)
      }
      expect(await getConfig<number>(key)).toBe(66) // 坏值全部拒绝，维持上一次合法值
    }
    await setConfig("signup_grant_credits", 200) // 还原（signup-grant 测试依赖）
    await setConfig("grant_expire_days", 0)
  })

  it("白名单外任意键仍宽松直存（现行为不变）", async () => {
    const { headers } = await makeAdminSession("ops", regA)
    const res = await app.request("http://x/admin-api/plans/configs/test_free_key", {
      method: "PUT",
      headers,
      body: JSON.stringify({ value: { anything: [1, "x", null] } }),
    })
    expect(res.status).toBe(200)
    expect(await getConfig<{ anything: unknown[] }>("test_free_key")).toEqual({ anything: [1, "x", null] })
  })
})
