import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { preDeduct, settle, settleFailed, settleContent, resolveStepHoldAmount } from "../src/services/billing-stub"
import { contentTiers, ContentTiersConfigError } from "../src/services/content-pricing"
import { grant, getBalance } from "../src/services/credits"
import { getConfigs, seedConfigs, setConfig } from "../src/services/config"
import { getDb, closeDb } from "../src/db/client"
import { billingConfigs, users } from "../src/db/schema"
import { createTestUser, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连真库

let userId = ""

// 本文件为钉死断言口径改写了 billing_configs 的这几个键——billing_configs 是全环境共享的
// 运营计费口径，测试跑完必须原样还原：留下测试值就是错价事故（content_tiers 尤甚，测试阶梯
// 比运营阶梯少一档，发版后会按缺档的梯子收钱）。
// 还原次序即风险次序：content_tiers 排第一——它留成测试阶梯（比运营阶梯少一档）是长期静默错价，
// 比后面几个标量键严重得多，绝不能因为前面某个键还原失败而轮不到它。
const MUTATED_CONFIG_KEYS = [
  "credit_cost.content_tiers",
  "credit_cost.read",
  "credit_cost.content_short",
  "credit_cost.content_long",
] as const
const configBackup = new Map<string, unknown>() // 未收录的键 = 本文件跑之前就不存在
let snapshotComplete = false // 快照整套取全才置真，见 restoreConfigs 的第 ① 条

/** 还原配置快照：原本有值的写回原值；原本不存在的删掉（绝不用编造值/种子值顶替）。
 *  ① 快照不完整就整体放弃还原：beforeAll 抛错/超时时 bun 照样跑 afterAll，此时 Map 里可能只有
 *     半套键——把「还没来得及快照」误判成「本来就不存在」会 DELETE 掉共享库里真实的计费口径
 *     （标书生成全员 400、read 口径没了还会在占位之后抛 500 leak 步位），比不还原严重得多。
 *  ② 逐键各自 try/catch：一个键还原失败不许连累后面的键（尤其不许跳过 content_tiers）。
 *  ③ 但失败必须响：错误收集完在循环后聚合抛出——吞成日志会让「共享库还留着测试口径」
 *     以整轮绿色收场，正是这次要堵的那种静默。 */
async function restoreConfigs(): Promise<void> {
  if (!snapshotComplete) return
  const failedKeys: string[] = []
  const errors: unknown[] = []
  for (const key of MUTATED_CONFIG_KEYS) {
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
  // 快照必须取在 seedConfigs 之前：种子会补建缺失键，之后再读就分不清「本来就有」与「种子刚建」，
  // 还原时会把测试自己造出来的键当既有值留下。
  // 一次 SELECT 取全表，不逐键往返：真库在公网隧道后面，串行远程往返会把 beforeAll 拖进
  // TEST_TIMEOUT_MS（超时则一个用例都跑不到）。
  const all = await getConfigs()
  for (const key of MUTATED_CONFIG_KEYS) {
    // 存在性用 hasOwn 判定，不能用 `v !== undefined`：值合法地存成 JSON null 时，
    // 后者会把它误判成「本来就不存在」，还原时直接 DELETE 掉真实配置。
    if (Object.hasOwn(all, key)) configBackup.set(key, all[key])
  }
  snapshotComplete = true // 只有整套读完才允许还原——半套快照去还原＝按半套信息删键
  await seedConfigs()
  // seedConfigs 不覆盖已存在键，旧环境值不会被刷成新默认；本套断言依赖的口径显式钉死，与环境/文件顺序解耦。
  await setConfig("credit_cost.read", 20)
  await setConfig("credit_cost.content_short", 40)
  await setConfig("credit_cost.content_long", 80)
  const u = await createTestUser(`+8615${Date.now().toString().slice(-9)}`)
  userId = u.id
})

// afterAll 无论断言成败/超时都会执行，所以还原不会被失败用例吞掉；
// try/finally 保证还原自身出错也不会漏掉清用户与关连接（否则进程挂在连接池上）。
afterAll(async () => {
  try {
    await restoreConfigs()
  } finally {
    await getDb().delete(users).where(eq(users.id, userId))
    await closeDb()
  }
})

describe("billing-stub → 真账本门面（spec302）", () => {
  it("preDeduct 真扣：余额减少、返回 holdId；settle 结算净消耗", async () => {
    await grant(userId, 60, { idempotencyKey: `g-${userId}` }) // 一次性授信，覆盖本 describe 后续各步 hold
    const r = await preDeduct(userId, "read", `ref1-${userId}`)
    expect(r.ok).toBe(true)
    expect(r.hold).toBe(20) // credit_cost.read 真实配置默认值
    expect(await getBalance(userId)).toBe(40)
    const cost = await settle(`ref1-${userId}`, r.holdId!, r.hold) // 非 content 步全额结算
    expect(cost).toBe(20)
    expect(await getBalance(userId)).toBe(40) // 净消耗 20
  })

  it("settleFailed 全额退还（净 0）", async () => {
    const r = await preDeduct(userId, "read", `ref2-${userId}`)
    expect(r.ok).toBe(true)
    const before = await getBalance(userId)
    await settleFailed(`ref2-${userId}`, r.holdId!)
    expect(await getBalance(userId)).toBe(before + 20)
  })

  it("余额不足 → ok:false，不产生扣减", async () => {
    const poor = await createTestUser(`+8616${Date.now().toString().slice(-9)}`)
    try {
      const r = await preDeduct(poor.id, "read", `ref3-${poor.id}`)
      expect(r).toEqual({ ok: false, hold: 0 })
      expect(await getBalance(poor.id)).toBe(0)
    } finally {
      await getDb().delete(users).where(eq(users.id, poor.id))
    }
  })

  it("content 步按产出总字数分档：预扣阶梯最大价，落档后多退", async () => {
    await setConfig("credit_cost.content_tiers", [
      { maxChars: 50_000, cost: 40 },
      { maxChars: 150_000, cost: 80 },
      { maxChars: null, cost: 260 },
    ])
    expect(await resolveStepHoldAmount("content")).toBe(260) // 预扣取最大价，防结算少补扣穿
    expect(await resolveStepHoldAmount("read")).toBeUndefined() // 其余步按 credit_cost.<step>
    await grant(userId, 600, { idempotencyKey: `gc-${userId}` })

    // 低档：总字数 3 万 → 结算 40，退 220
    const rS = await preDeduct(userId, "content", `refc1-${userId}`, 260)
    expect(rS.hold).toBe(260)
    expect(await settleContent(`refc1-${userId}`, rS.holdId!, rS.hold, 30_000)).toBe(40)

    // 顶档：总字数 40 万 → 足额 260
    const rL = await preDeduct(userId, "content", `refc2-${userId}`, 260)
    expect(await settleContent(`refc2-${userId}`, rL.holdId!, rL.hold, 400_000)).toBe(260)

    // 兼容：预扣额小于落档价（发版时的在途 run）→ 钳到预扣额，不扣穿
    const rOld = await preDeduct(userId, "content", `refc3-${userId}`, 80)
    expect(await settleContent(`refc3-${userId}`, rOld.holdId!, rOld.hold, 400_000)).toBe(80)
  })

  // 路由把 ContentTiersConfigError 转 400、其余照抛 5xx（projects.ts 的 catch）。那里的用例注入的是
  // 手搓的 ContentTiersConfigError，只证明了 instanceof 分支；这里补另一半——真·坏配置确实会被
  // contentTiers() 包成这个类型。少了这条，有人把 contentTiers() 简化成裸 parse，缺阶梯就会变成
  // 5xx（C 端丢掉「联系运营配阶梯」的引导、值班去查根本没坏的基建），而全部测试照样绿。
  it("真·坏阶梯 → contentTiers/resolveStepHoldAmount 抛 ContentTiersConfigError（配置态，非基建故障）", async () => {
    const bad: [string, unknown][] = [
      ["缺顶档", [{ maxChars: 50_000, cost: 40 }]],
      ["空数组", []],
      ["非数组", { maxChars: null, cost: 40 }],
      ["cost 非整数", [{ maxChars: null, cost: 1.5 }]],
      ["多个顶档", [{ maxChars: null, cost: 40 }, { maxChars: null, cost: 80 }]],
    ]
    for (const [label, value] of bad) {
      await setConfig("credit_cost.content_tiers", value)
      expect(contentTiers(), label).rejects.toBeInstanceOf(ContentTiersConfigError)
      expect(resolveStepHoldAmount("content"), label).rejects.toBeInstanceOf(ContentTiersConfigError)
    }
  })
})
