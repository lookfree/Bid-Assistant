import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { sql } from "drizzle-orm"
import { getDb, closeDb } from "../src/db/client"
import { billingConfigs } from "../src/db/schema"
import { getConfig, getConfigs, seedConfigs, setConfig } from "../src/services/config"
import { BILLING_SEED } from "../src/config/billing-seed"
import { CREDIT_COST_ITEMS } from "../src/config/credit-cost-items"
import { TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS)

// 本套测试对 billing_configs 做种子/改写：跑前清掉种子键，跑完恢复种子
// （该表为全局配置、无 user 归属）
async function wipeSeedKeys() {
  for (const key of Object.keys(BILLING_SEED)) {
    await getDb().delete(billingConfigs).where(sql`${billingConfigs.key} = ${key}`)
  }
  // 历史遗留孤儿键：口径从 content 拆成 content_short/long 后 content 不再入种子，
  // 但 seedConfigs 只增不删，旧环境仍残留 credit_cost.content——避免污染断言，先清掉。
  await getDb().delete(billingConfigs).where(sql`${billingConfigs.key} = 'credit_cost.content'`)
}

beforeAll(wipeSeedKeys)

afterAll(async () => {
  await wipeSeedKeys()
  await seedConfigs() // 留一套干净种子给环境
  await closeDb()
})

describe("spec301 配置服务", () => {
  it("种子写入后可读操作积分口径与推荐规则", async () => {
    await seedConfigs()
    expect(await getConfig<number>("credit_cost.read")).toBe(20)
    const rules = await getConfig<{ capPerUser: number }>("referral_rules")
    expect(rules?.capPerUser).toBe(500)
    const poll = await getConfig<{ windowMinutes: number }>("payment_poll")
    expect(poll?.windowMinutes).toBe(6) // 收钱吧官方轮询窗口
  })

  it("getConfigs 前缀过滤：credit_cost.* 各项口径齐全（含计费阶梯）", async () => {
    const costs = await getConfigs("credit_cost.")
    for (const i of CREDIT_COST_ITEMS) expect(costs[`credit_cost.${i.key}`]).toBe(i.default)
    // 标书生成不在扁平口径里，走阶梯键（数组）
    expect(Array.isArray(costs["credit_cost.content_tiers"])).toBe(true)
  })

  it("seedConfigs 不覆盖已存在的 key（运营改过的值保持）", async () => {
    await setConfig("credit_cost.read", 999)
    await seedConfigs() // 不应把 999 改回 10
    expect(await getConfig<number>("credit_cost.read")).toBe(999)
  })

  it("setConfig upsert 即生效", async () => {
    await setConfig("renewal_grace_days", 7)
    expect(await getConfig<number>("renewal_grace_days")).toBe(7)
  })

  it("未知 key → undefined", async () => {
    expect(await getConfig("no_such_key")).toBeUndefined()
  })
})
