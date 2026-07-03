import { expect, test, mock } from "bun:test"
import { withCronLock, instanceId, type RedisLike } from "../src/services/cron"

/** 最小 mock：set 按外部预设返回 OK 或 null；eval 模拟 Lua CAS（值匹配才删）。 */
function makeMock(setResult: "OK" | null) {
  const store = new Map<string, string>()
  const calls: { eval: unknown[][]; pexpire: unknown[][] } = { eval: [], pexpire: [] }
  if (setResult === "OK") store.set("lock:cron:job", instanceId)
  const client = {
    set: mock(async () => setResult),
    eval: mock(async (_lua: string, _n: number, key: string, val: string) => {
      calls.eval.push([key, val])
      if (store.get(key) === val) {
        store.delete(key) // CAS 命中 → 删
        return 1
      }
      return 0 // 值不符 → 不删
    }),
    pexpire: mock(async (...a: unknown[]) => {
      calls.pexpire.push(a)
      return 1
    }),
  } as unknown as RedisLike
  return { client, store, calls }
}

test("抢到锁 → 执行 fn → Lua CAS 删自己持有的锁", async () => {
  const { client, store, calls } = makeMock("OK")
  const ran = await withCronLock("job", async () => "done", { client })
  expect(ran).toBe("done")
  expect(store.has("lock:cron:job")).toBe(false) // 锁已释放
  expect(calls.eval[0]).toEqual(["lock:cron:job", instanceId]) // CAS 用本实例值
})

test("没抢到锁 → 跳过（fn 不执行, 返回 undefined）", async () => {
  const { client } = makeMock(null)
  let executed = false
  const ran = await withCronLock(
    "job",
    async () => {
      executed = true
      return "x"
    },
    { client },
  )
  expect(ran).toBeUndefined()
  expect(executed).toBe(false) // 别的实例持锁 → 本实例不跑
})

test("Lua CAS：锁值是别人的 instanceId → 不删", async () => {
  const { client, store } = makeMock("OK")
  store.set("lock:cron:job", "OTHER-INSTANCE") // 模拟 TTL 过期后被他人抢占
  await withCronLock("job", async () => "done", { client })
  expect(store.get("lock:cron:job")).toBe("OTHER-INSTANCE") // 值不符 → 未误删
})

test("fn 抛错也必须释放锁（finally 路径）", async () => {
  const { client, store } = makeMock("OK")
  await expect(
    withCronLock("job", async () => {
      throw new Error("job 内部失败")
    }, { client }),
  ).rejects.toThrow("job 内部失败")
  expect(store.has("lock:cron:job")).toBe(false) // 异常路径也释放，不留 300s 死锁窗口
})

test("watchdog：fn 执行期周期 pexpire 续租，结束后停止", async () => {
  const { client, calls } = makeMock("OK")
  await withCronLock(
    "job",
    () => new Promise((r) => setTimeout(r, 1200)),
    { client, ttlSec: 3, watchdog: true }, // renewMs = max(1000, 3000/3) = 1000ms → fn 1200ms 内续租 ≥1 次
  )
  expect(calls.pexpire.length).toBeGreaterThanOrEqual(1) // 执行期间续过租
  const after = calls.pexpire.length
  await new Promise((r) => setTimeout(r, 1100))
  expect(calls.pexpire.length).toBe(after) // fn 结束后 watchdog 已清
})

test("两实例并发抢同一锁，只有一个 fn 执行", async () => {
  let executed = 0
  const winner = makeMock("OK") // 实例 A 抢到
  const loser = makeMock(null) // 实例 B 没抢到
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
