import { expect, test, mock } from "bun:test"
import { registerCron, startCronRunner, type RedisLike } from "../src/services/cron"

/** 永远抢到锁的 mock（验证 tick 触发语义；互斥语义在 cron-lock.test.ts）。 */
function lockingClient(): RedisLike {
  return {
    set: mock(async () => "OK"),
    eval: mock(async () => 1),
    pexpire: mock(async () => 1),
  } as unknown as RedisLike
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test("registerCron 按 everyMs 周期触发 jobFn；stop 后不再触发", async () => {
  const client = lockingClient()
  let runs = 0
  const { stop } = registerCron("ticker", 20, async () => {
    runs++
  }, { client })
  await sleep(75) // 75ms / 20ms ≈ 3 次 tick
  stop()
  const after = runs
  expect(after).toBeGreaterThanOrEqual(2)
  await sleep(40)
  expect(runs).toBe(after) // stop 后不再触发
})

test("某次 jobFn 抛错不影响后续 tick（吞错自愈）", async () => {
  const client = lockingClient()
  let runs = 0
  const { stop } = registerCron("resilient", 20, async () => {
    runs++
    if (runs === 1) throw new Error("第一次故意失败")
  }, { client })
  await sleep(75)
  stop()
  expect(runs).toBeGreaterThanOrEqual(2) // 第一次抛错后仍继续 tick
})

test("没抢到锁的 tick 不执行 jobFn（分布式单例语义贯穿 tick）", async () => {
  const client = {
    set: mock(async () => null), // 永远抢不到
    eval: mock(async () => 0),
    pexpire: mock(async () => 1),
  } as unknown as RedisLike
  let runs = 0
  const { stop } = registerCron("loser", 20, async () => {
    runs++
  }, { client })
  await sleep(75)
  stop()
  expect(runs).toBe(0) // 别的实例持锁 → 本实例每 tick 都跳过
})

test("startCronRunner 注册多个 job 都按周期触发, stopAll 全停", async () => {
  const client = lockingClient()
  const hits = { a: 0, b: 0 }
  const { stopAll } = startCronRunner(
    [
      { name: "job-a", everyMs: 20, jobFn: async () => void hits.a++ },
      { name: "job-b", everyMs: 20, jobFn: async () => void hits.b++ },
    ],
    { client },
  )
  await sleep(75)
  stopAll()
  expect(hits.a).toBeGreaterThanOrEqual(2)
  expect(hits.b).toBeGreaterThanOrEqual(2)
  const snap = { ...hits }
  await sleep(40)
  expect(hits).toEqual(snap) // stopAll 后全部停止
})
