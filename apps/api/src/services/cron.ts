import { randomUUID } from "node:crypto"
import type Redis from "ioredis"
import { getRedis } from "../redis/client"

// Redis 分布式单例 Cron（架构 §6.4）：每实例进程内 tick，执行前抢 Redis 锁，
// 抢到的实例独占执行 → 集群内同一时刻只有一个实例在跑同名 job。
// Redis 只管「单实例执行」；「什么到期」以 DB 为唯一真相，job 体逐条带业务幂等键，
// 锁异常双触发也不会重复扣款。锁 TTL 自愈：实例挂掉锁到期，下一 tick 别人接管。

/** 本进程唯一标识：锁的 value，Lua CAS 只删自己持有的锁。 */
export const instanceId: string = randomUUID()

/** 仅依赖这三个命令，便于单测注入 mock（不连真 Redis）。 */
export type RedisLike = Pick<Redis, "set" | "eval" | "pexpire">

const LOCK_PREFIX = "lock:cron:" // 经 ioredis keyPrefix("bid:") → 实际键 bid:lock:cron:<name>
const DEFAULT_TTL_SEC = 300

/** Lua CAS：仅当锁值 == 本实例时才删，杜绝 TTL 过期后误删他人抢到的锁。 */
const RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`

/**
 * 抢锁执行：SET lock NX EX ttl 抢到 → 跑 fn → Lua CAS 释放；没抢到 → 返回 undefined（本 tick 跳过）。
 * watchdog:true 时 fn 执行期每 ttl/3（下限 1s）PEXPIRE 续租，防长任务锁过期被别人抢。
 * fn 抛错也走 finally 释放，不留 TTL 长度的死锁窗口。
 */
export async function withCronLock<T>(
  name: string,
  fn: () => Promise<T>,
  opts: { ttlSec?: number; watchdog?: boolean; client?: RedisLike } = {},
): Promise<T | undefined> {
  const client = opts.client ?? getRedis()
  const ttlSec = opts.ttlSec ?? DEFAULT_TTL_SEC
  const key = LOCK_PREFIX + name

  // SET key <instanceId> NX EX ttl —— 抢到返回 "OK"，已有持锁者返回 null
  const acquired = await client.set(key, instanceId, "EX", ttlSec, "NX")
  if (acquired !== "OK") return undefined

  let timer: ReturnType<typeof setInterval> | undefined
  if (opts.watchdog) {
    const renewMs = Math.max(1000, Math.floor((ttlSec * 1000) / 3))
    timer = setInterval(() => {
      // 续租失败只记日志：锁丢了顶多双触发，业务幂等键兜底
      void client.pexpire(key, ttlSec * 1000).catch((err) => console.error(`[cron:${name}] 续租失败`, err))
    }, renewMs)
  }

  try {
    return await fn()
  } finally {
    if (timer) clearInterval(timer)
    await client.eval(RELEASE_LUA, 1, key, instanceId)
  }
}

/**
 * 注册进程内 cron：每 everyMs 一次 tick，每 tick 抢锁执行 jobFn（抢到才跑 = 分布式单例）。
 * 单 tick 抛错吞掉记日志，不影响后续 tick（自愈）。返回 stop() 清定时器。
 */
export function registerCron(
  name: string,
  everyMs: number,
  jobFn: () => Promise<void>,
  opts: { client?: RedisLike; watchdog?: boolean } = {},
): { stop: () => void } {
  const tick = async () => {
    try {
      await withCronLock(name, jobFn, { client: opts.client, watchdog: opts.watchdog })
    } catch (err) {
      console.error(`[cron:${name}] tick 失败`, err)
    }
  }
  const timer = setInterval(() => void tick(), everyMs)
  timer.unref?.() // 不阻止进程退出（worker/api 主循环负责存活）
  return { stop: () => clearInterval(timer) }
}

/** 一个待注册的 cron job（spec304 签到对账单 / spec305 提醒 / spec306 对账+积分过期 各自产出）。 */
export type CronJob = {
  name: string // 锁名，集群唯一
  everyMs: number // tick 间隔（分钟级，如 60_000）
  jobFn: () => Promise<void> // job 体：以 DB 为准查到期项、逐条幂等处理
  watchdog?: boolean // 长任务续租
}

/** worker/api 启动时批量注册全部 cron job；stopAll() 供优雅停机/测试清定时器。 */
export function startCronRunner(jobs: CronJob[], opts: { client?: RedisLike } = {}): { stopAll: () => void } {
  const handles = jobs.map((j) => registerCron(j.name, j.everyMs, j.jobFn, { client: opts.client, watchdog: j.watchdog }))
  return { stopAll: () => handles.forEach((h) => h.stop()) }
}
