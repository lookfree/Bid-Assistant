import { expect, test, mock } from "bun:test"
import { withCronLock, type RedisLike } from "../src/services/cron"
import { makeRedisMock } from "./helpers/redis-mock"
import { sleep } from "./helpers/time"

test("抢到锁 → 执行 fn → Lua CAS 删自己持有的锁", async () => {
  const m = makeRedisMock("OK")
  const ran = await withCronLock("job", async () => "done", { client: m.client })
  expect(ran).toBe("done")
  expect(m.store.has("lock:cron:job")).toBe(false) // 锁已释放
  const token = m.set.mock.calls[0]![1] // 本次持锁 token
  expect(m.eval.mock.calls[0]!.slice(2)).toEqual(["lock:cron:job", token]) // CAS 用本次 token
})

test("没抢到锁 → 跳过（fn 不执行, 返回 undefined）", async () => {
  const m = makeRedisMock(null)
  let executed = false
  const ran = await withCronLock(
    "job",
    async () => {
      executed = true
      return "x"
    },
    { client: m.client },
  )
  expect(ran).toBeUndefined()
  expect(executed).toBe(false) // 别的实例持锁 → 本实例不跑
})

test("Lua CAS：fn 期间锁易主 → 不误删新持有者的锁", async () => {
  const m = makeRedisMock("OK")
  await withCronLock(
    "job",
    async () => {
      m.store.set("lock:cron:job", "OTHER-TOKEN") // 模拟 TTL 过期后被他人抢占
    },
    { client: m.client },
  )
  expect(m.store.get("lock:cron:job")).toBe("OTHER-TOKEN") // 值不符 → 未误删
})

test("每次抢锁生成一次性 token：同进程两次持锁值不同（旧调用释放不了新锁）", async () => {
  // 回归：token 若是进程级 id，jobFn 超 TTL 后同进程重抢，旧调用 finally 的 CAS 会误删新锁
  const m = makeRedisMock("OK")
  await withCronLock("job", async () => {}, { client: m.client })
  await withCronLock("job", async () => {}, { client: m.client })
  const [v1, v2] = [m.set.mock.calls[0]![1], m.set.mock.calls[1]![1]]
  expect(v1).not.toBe(v2)
})

test("fn 抛错也必须释放锁（finally 路径）", async () => {
  const m = makeRedisMock("OK")
  await expect(
    withCronLock(
      "job",
      async () => {
        throw new Error("job 内部失败")
      },
      { client: m.client },
    ),
  ).rejects.toThrow("job 内部失败")
  expect(m.store.has("lock:cron:job")).toBe(false) // 异常路径也释放，不留 300s 死锁窗口
})

test("释放锁失败不吞 fn 的结果（锁靠 TTL 自愈）", async () => {
  const client = {
    set: mock(async () => "OK"),
    eval: mock(async () => {
      throw new Error("Redis 连接已断")
    }),
  } as unknown as RedisLike
  const ran = await withCronLock("job", async () => "business-result", { client })
  expect(ran).toBe("business-result") // 释放失败只记日志，不得让成功的 job 变成 rejection
})

test("watchdog：fn 执行期 CAS 续租，结束后停止", async () => {
  const m = makeRedisMock("OK")
  await withCronLock("job", () => sleep(1200), { client: m.client, ttlSec: 3, watchdog: true }) // renewMs = 1000
  expect(m.renewCalls().length).toBeGreaterThanOrEqual(1) // 执行期间续过租
  const token = m.set.mock.calls[0]![1]
  expect(m.renewCalls()[0]!.slice(2, 4)).toEqual(["lock:cron:job", token]) // 续租也用本次 token 做 CAS
  const after = m.renewCalls().length
  await sleep(1100)
  expect(m.renewCalls().length).toBe(after) // fn 结束后 watchdog 已清
})

test("watchdog：锁已易主 → 停止续租（不给别人的锁续命）", async () => {
  const m = makeRedisMock("OK")
  await withCronLock(
    "job",
    async () => {
      m.store.set("lock:cron:job", "OTHER-TOKEN") // 持锁期间锁被他人抢走
      await sleep(2300) // 覆盖 2 个续租窗口（renewMs=1000）
    },
    { client: m.client, ttlSec: 3, watchdog: true },
  )
  expect(m.renewCalls().length).toBe(1) // 第一次续租发现易主(返回 0) → 停止，不再有第二次
  expect(m.store.get("lock:cron:job")).toBe("OTHER-TOKEN") // 释放同样 CAS 不命中，未误删
})

test("两实例并发抢同一锁，只有一个 fn 执行", async () => {
  let executed = 0
  const winner = makeRedisMock("OK") // 实例 A 抢到
  const loser = makeRedisMock(null) // 实例 B 没抢到
  await Promise.all([
    withCronLock("dedup", async () => {
      executed++
    }, { client: winner.client }),
    withCronLock("dedup", async () => {
      executed++
    }, { client: loser.client }),
  ])
  expect(executed).toBe(1) // 集群内同一时刻单实例执行
})
