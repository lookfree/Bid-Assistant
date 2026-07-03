import { expect, test } from "bun:test"
import { registerCron, startCronRunner } from "../src/services/cron"
import { makeRedisMock } from "./helpers/redis-mock"
import { sleep } from "./helpers/time"

test("注册时立即首跑一次（日级 everyMs + 频繁重启也不会静默不跑）", async () => {
  const m = makeRedisMock("OK")
  let runs = 0
  const { stop } = registerCron("daily", 10_000, async () => {
    runs++
  }, { client: m.client })
  await sleep(30)
  await stop()
  expect(runs).toBe(1) // 不等 everyMs 到点，注册即首跑；重复触发由锁+业务幂等键去重
})

test("registerCron 按 everyMs 周期触发 jobFn；stop 后不再触发", async () => {
  const m = makeRedisMock("OK")
  let runs = 0
  const { stop } = registerCron("ticker", 20, async () => {
    runs++
  }, { client: m.client })
  await sleep(75) // 首跑 + 75ms/20ms ≈ 3 次 tick
  await stop()
  const after = runs
  expect(after).toBeGreaterThanOrEqual(2)
  await sleep(40)
  expect(runs).toBe(after) // stop 后不再触发
})

test("某次 jobFn 抛错不影响后续 tick（吞错自愈）", async () => {
  const m = makeRedisMock("OK")
  let runs = 0
  const { stop } = registerCron("resilient", 20, async () => {
    runs++
    if (runs === 1) throw new Error("第一次故意失败")
  }, { client: m.client })
  await sleep(75)
  await stop()
  expect(runs).toBeGreaterThanOrEqual(2) // 第一次抛错后仍继续 tick
})

test("没抢到锁的 tick 不执行 jobFn（分布式单例语义贯穿 tick）", async () => {
  const m = makeRedisMock(null) // 永远抢不到
  let runs = 0
  const { stop } = registerCron("loser", 20, async () => {
    runs++
  }, { client: m.client })
  await sleep(75)
  await stop()
  expect(runs).toBe(0) // 别的实例持锁 → 本实例每 tick 都跳过
})

test("上一 tick 未结束时本 tick 跳过（同进程不重叠执行）", async () => {
  const m = makeRedisMock("OK")
  let active = 0
  let maxActive = 0
  let runs = 0
  const { stop } = registerCron("slow", 20, async () => {
    active++
    maxActive = Math.max(maxActive, active)
    runs++
    await sleep(90) // jobFn 比 everyMs 慢 → 中间 4 个 tick 应被跳过
    active--
  }, { client: m.client })
  await sleep(200)
  await stop()
  expect(maxActive).toBe(1) // 任一时刻同进程只有一个 jobFn 在跑
  expect(runs).toBeLessThanOrEqual(3) // 跳过而非排队堆积
})

test("stop() 等在途 jobFn 收尾（停机不腰斩任务）", async () => {
  const m = makeRedisMock("OK")
  let finished = false
  const { stop } = registerCron("draining", 10_000, async () => {
    await sleep(60)
    finished = true
  }, { client: m.client })
  await sleep(10) // 首跑已开始、未结束
  await stop() // 必须等在途 tick 跑完
  expect(finished).toBe(true)
})

test("startCronRunner 注册多个 job 都按周期触发, stopAll 全停", async () => {
  const m = makeRedisMock("OK")
  const hits = { a: 0, b: 0 }
  const { stopAll } = startCronRunner(
    [
      { name: "job-a", everyMs: 20, jobFn: async () => void hits.a++ },
      { name: "job-b", everyMs: 20, jobFn: async () => void hits.b++ },
    ],
    { client: m.client },
  )
  await sleep(75)
  await stopAll()
  expect(hits.a).toBeGreaterThanOrEqual(2)
  expect(hits.b).toBeGreaterThanOrEqual(2)
  const snap = { ...hits }
  await sleep(40)
  expect(hits).toEqual(snap) // stopAll 后全部停止
})
