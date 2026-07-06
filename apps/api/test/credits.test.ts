import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { getDb, closeDb } from "../src/db/client"
import { users } from "../src/db/schema"
import { getBalance, grant, hold, release, settle } from "../src/services/credits"
import { InsufficientCreditsError } from "../src/services/credits-errors"
import { seedConfigs, setConfig } from "../src/services/config"
import { makeLedgerUser, TEST_TIMEOUT_MS, expectConflict } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS)

const madeUsers: string[] = []
const makeUser = () => makeLedgerUser((id) => madeUsers.push(id))

beforeAll(async () => {
  await seedConfigs()
  // 钱路测试要确定：seedConfigs 对已存在键 onConflictDoNothing，不会把旧环境的值刷新成新默认，
  // 故这里显式钉住本套断言依赖的口径值（read=20），与环境/文件执行顺序解耦。
  await setConfig("credit_cost.read", 20)
})

afterAll(async () => {
  for (const id of madeUsers) await getDb().delete(users).where(eq(users.id, id)) // 流水/余额级联删
  await closeDb()
})

describe("spec302 账本引擎", () => {
  it("余额 = Σ流水；grant 幂等；非正入账被拒", async () => {
    const userId = await makeUser()
    await grant(userId, 100, { idempotencyKey: `g1-${userId}` })
    await grant(userId, 50, { idempotencyKey: `g2-${userId}` })
    expect(await getBalance(userId)).toBe(150)
    await grant(userId, 100, { idempotencyKey: `g1-${userId}` }) // 重复幂等键 → 忽略
    expect(await getBalance(userId)).toBe(150)
    await expectConflict(() => grant(userId, 0, { idempotencyKey: `g0-${userId}` }))
    await expectConflict(() => grant(userId, -5, { idempotencyKey: `gn-${userId}` }))
  })

  it("hold 预扣（N=配置口径）+ release 全额退还净 0；均幂等", async () => {
    const userId = await makeUser()
    await grant(userId, 30, { idempotencyKey: `g-${userId}` })
    const { holdId, amount } = await hold(userId, "read", { ref: `run-${userId}`, idempotencyKey: `h-${userId}` })
    expect(amount).toBe(20) // credit_cost.read 真实配置默认值
    expect(await getBalance(userId)).toBe(10)
    // hold 幂等：同 key 返回原 holdId、不再扣
    const again = await hold(userId, "read", { ref: `run-${userId}`, idempotencyKey: `h-${userId}` })
    expect(again.holdId).toBe(holdId)
    expect(await getBalance(userId)).toBe(10)
    await release(holdId, { idempotencyKey: `r-${userId}` })
    expect(await getBalance(userId)).toBe(30)
    await release(holdId, { idempotencyKey: `r-${userId}` }) // release 幂等
    expect(await getBalance(userId)).toBe(30)
  })

  it("余额不足抛 InsufficientCreditsError；未配置口径直接失败（不静默免费）", async () => {
    const userId = await makeUser()
    await grant(userId, 5, { idempotencyKey: `g-${userId}` })
    expect(hold(userId, "read", { idempotencyKey: `h-${userId}` })).rejects.toBeInstanceOf(InsufficientCreditsError)
    await expectConflict(() => hold(userId, "no_such_op", { idempotencyKey: `hx-${userId}` }))
  })

  it("settle 多退少补：净消耗=实际用量；幂等", async () => {
    const userId = await makeUser()
    await grant(userId, 30, { idempotencyKey: `g-${userId}` })
    const { holdId } = await hold(userId, "read", { ref: `run-${userId}`, idempotencyKey: `h-${userId}` }) // -20
    await settle(holdId, 6, { idempotencyKey: `s-${userId}` }) // 实际 6 → 退 14
    expect(await getBalance(userId)).toBe(24) // 30 -20 +14 = 30 - 实际6
    await settle(holdId, 6, { idempotencyKey: `s-${userId}` }) // 幂等
    expect(await getBalance(userId)).toBe(24)
  })

  it("settle 少补：实际用量超过预扣时补扣", async () => {
    const userId = await makeUser()
    await grant(userId, 30, { idempotencyKey: `g-${userId}` })
    const { holdId } = await hold(userId, "read", { ref: `run-${userId}`, idempotencyKey: `h-${userId}` }) // -10
    await settle(holdId, 13, { idempotencyKey: `s-${userId}` }) // 超用 3 → 补扣
    expect(await getBalance(userId)).toBe(17) // 30 - 13
  })

  it("每 hold 至多一条了结：settle 后再 release 是 no-op（双返还回归）", async () => {
    const userId = await makeUser()
    await grant(userId, 30, { idempotencyKey: `g-${userId}` })
    const { holdId } = await hold(userId, "read", { ref: `run-${userId}`, idempotencyKey: `h-${userId}` }) // -10
    await settle(holdId, 8, { idempotencyKey: `s-${userId}` }) // 净扣 8 → 22
    expect(await getBalance(userId)).toBe(22)
    await release(holdId, { idempotencyKey: `r-${userId}` }) // 异常路径补退还 → 必须被唯一索引吞掉
    expect(await getBalance(userId)).toBe(22) // 不得双返还
  })

  it("release 后再 settle 也是 no-op（反向双记回归）", async () => {
    const userId = await makeUser()
    await grant(userId, 30, { idempotencyKey: `g-${userId}` })
    const { holdId } = await hold(userId, "read", { ref: `run-${userId}`, idempotencyKey: `h-${userId}` })
    await release(holdId, { idempotencyKey: `r-${userId}` }) // 净 0 → 30
    expect(await getBalance(userId)).toBe(30)
    await settle(holdId, 8, { idempotencyKey: `s-${userId}` }) // 已了结 → no-op
    expect(await getBalance(userId)).toBe(30)
  })

  it("并发同幂等键 hold：全部拿到同一 holdId，只扣一次", async () => {
    const userId = await makeUser()
    await grant(userId, 30, { idempotencyKey: `g-${userId}` })
    const results = await Promise.all(
      Array.from({ length: 5 }, () => hold(userId, "read", { idempotencyKey: `same-${userId}` })),
    )
    const ids = new Set(results.map((r) => r.holdId))
    expect(ids.size).toBe(1)
    expect(await getBalance(userId)).toBe(10) // 只扣一次（30 - read 20）
  })

  it("并发首扣不超扣（锁 credit_balances 用户行作串行化点）", async () => {
    // 余额恰够 1 次 hold（read=20）：10 个并发只能成功 1 个，余额绝不为负
    const userId = await makeUser()
    await grant(userId, 20, { idempotencyKey: `g-${userId}` })
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => hold(userId, "read", { idempotencyKey: `hc-${userId}-${i}` })),
    )
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(await getBalance(userId)).toBe(0)
  })
})
