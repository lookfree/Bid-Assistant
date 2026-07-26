import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import { getDb, closeDb } from "../src/db/client"
import { billingConfigs } from "../src/db/schema"
import { getConfig, getConfigs, seedConfigs, setConfig } from "../src/services/config"
import { BILLING_SEED } from "../src/config/billing-seed"
import { CREDIT_COST_ITEMS } from "../src/config/credit-cost-items"
import { CONTENT_TIERS_KEY } from "../src/services/content-pricing"
import { TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS)

// 本套测试断言的是「种子写入后的默认口径」，所以必须先把种子键清空再 seedConfigs()。但
// billing_configs 是**全环境共享的运营计费口径**（测试连真库），清掉再补种子 = 把运营改过的值
// 静默换成种子默认值，且残留值本身完全合法、没有任何告警会响。故本文件按 billing-stub.test.ts
// 的同一套加固手法：beforeAll 先整套快照 → 清 → 跑用例 → afterAll 原样还原。
//
// 还原次序即风险次序：content_tiers 排第一——它被换成种子阶梯是长期静默错价（运营的
// 「20万字 120 积分」会变成种子的 80），比后面的标量键严重得多，绝不能因为前面某个键还原
// 失败而轮不到它。
const SEED_KEYS: string[] = [
  CONTENT_TIERS_KEY,
  ...Object.keys(BILLING_SEED).filter((k) => k !== CONTENT_TIERS_KEY),
]
const configBackup = new Map<string, unknown>() // 未收录的键 = 本文件跑之前就不存在
let snapshotComplete = false // 快照整套取全才置真，见 restoreConfigs 的第 ① 条

/** 取快照：必须跑在任何 delete/seed 之前，否则分不清「本来就有」与「测试自己造出来的」。
 *  **一次 SELECT 取全表，绝不逐键往返**：真库在公网隧道后面，种子键有 15+ 个，串行 15+ 次
 *  远程往返在链路稍差时就能在任何一个用例体开跑之前吃满 TEST_TIMEOUT_MS（实测 20s 超时、
 *  0 个用例执行）——快照越慢，「守护共享计费口径」这件事本身越容易把整套测试卡死。 */
async function snapshotSeedKeys(): Promise<void> {
  const all = await getConfigs() // 无前缀 = 全表，单次查询
  for (const key of SEED_KEYS) {
    // 存在性用 hasOwn 判定，不能用 `v !== undefined`：某个键的值合法地存成 JSON null 时，
    // 后者会把它误判成「本来就不存在」，还原时直接 DELETE 掉真实配置。
    if (Object.hasOwn(all, key)) configBackup.set(key, all[key])
  }
  snapshotComplete = true // 只有整套读完才允许还原——半套快照去还原＝按半套信息删键
}

/** 清键：同样一次往返（`IN (...)`），理由同 snapshotSeedKeys——beforeAll 里每多一次远程往返，
 *  整套测试就更接近「一个用例都没跑就超时」。 */
async function wipeSeedKeys(): Promise<void> {
  // 历史遗留孤儿键 credit_cost.content：口径从 content 拆成 content_short/long 后它不再入种子，
  // 但 seedConfigs 只增不删，旧环境仍残留——避免污染断言，一并清掉。
  // （该键今天已无任何读取方，清掉即彻底作废，故不进快照、也不还原。）
  await getDb()
    .delete(billingConfigs)
    .where(inArray(billingConfigs.key, [...SEED_KEYS, "credit_cost.content"]))
}

/** 还原配置快照：原本有值的写回原值；原本不存在的删掉（绝不用种子默认值顶替——那正是本次要堵的
 *  静默换价）。afterAll 无论断言成败/超时都会执行，所以还原不会被失败用例吞掉。
 *  ① 快照不完整就整体放弃还原：beforeAll 抛错/超时时 bun 照样跑 afterAll，此时 Map 里可能只有
 *     半套键——把「还没来得及快照」误判成「本来就不存在」会 DELETE 掉共享库里真实的计费口径，
 *     比不还原严重得多。
 *  ② 逐键各自 try/catch：一个键还原失败不许连累后面的键（尤其不许跳过 content_tiers）。
 *  ③ 但失败必须响：错误收集完在循环后聚合抛出——吞成日志会让「共享库还留着种子默认价」
 *     以整轮绿色收场。 */
async function restoreConfigs(): Promise<void> {
  if (!snapshotComplete) return
  const failedKeys: string[] = []
  const errors: unknown[] = []
  for (const key of SEED_KEYS) {
    try {
      if (configBackup.has(key)) await setConfig(key, configBackup.get(key))
      else await getDb().delete(billingConfigs).where(eq(billingConfigs.key, key))
    } catch (e) {
      failedKeys.push(key)
      errors.push(e)
    }
  }
  if (failedKeys.length) throw new AggregateError(errors, `还原共享配置失败（需人工核对）：${failedKeys.join(", ")}`)
}

beforeAll(async () => {
  await snapshotSeedKeys()
  await wipeSeedKeys()
})

// try/finally 保证还原自身出错也不会漏关连接（否则进程挂在连接池上）。
afterAll(async () => {
  try {
    await restoreConfigs()
  } finally {
    await closeDb()
  }
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
