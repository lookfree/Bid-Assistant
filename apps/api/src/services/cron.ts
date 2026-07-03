import { randomUUID } from "node:crypto"
import type Redis from "ioredis"
import { getRedis } from "../redis/client"

// Redis 分布式单例 Cron（架构 §6.4）：每实例进程内 tick，执行前抢 Redis 锁，
// 抢到的实例独占执行 → 集群内同一时刻只有一个实例在跑同名 job。
// Redis 只管「单实例执行」；「什么到期」以 DB 为唯一真相，job 体逐条带业务幂等键，
// 锁异常双触发也不会重复扣款。锁 TTL 自愈：实例挂掉锁到期，下一 tick 别人接管。

/** 本进程唯一标识（日志/排障用；锁 value 用每次抢锁的一次性 token，见 withCronLock）。 */
export const instanceId: string = randomUUID()

/** 仅依赖这两个命令，便于单测注入 mock（不连真 Redis）。 */
export type RedisLike = Pick<Redis, "set" | "eval">

const LOCK_PREFIX = "lock:cron:" // 经 ioredis keyPrefix("bid:") → 实际键 bid:lock:cron:<name>
const DEFAULT_TTL_SEC = 300

/** Lua CAS 释放：仅当锁值 == 本次持锁 token 才删，杜绝 TTL 过期后误删他人（或同进程下一次持锁）的锁。 */
const RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`

/** Lua CAS 续租：值匹配才 PEXPIRE。裸 PEXPIRE 会在锁易主后给别人的锁续命（他人崩溃时 TTL 自愈失效）。 */
const RENEW_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end`

/**
 * 抢锁执行：SET lock NX EX ttl 抢到 → 跑 fn → Lua CAS 释放；没抢到 → 返回 undefined（本 tick 跳过）。
 * 锁 value 是本次调用生成的一次性 token（非进程级 id）：jobFn 超过 TTL 后同进程重抢，
 * 旧调用的释放/续租也无法误伤新锁。
 * watchdog:true 时 fn 执行期每 ttl/3（下限 1s）CAS 续租；发现锁已易主则停止续租并告警。
 * fn 抛错也走 finally 释放；释放本身的失败只记日志（锁靠 TTL 自愈），不吞 fn 的结果或原始异常。
 */
export async function withCronLock<T>(
  name: string,
  fn: () => Promise<T>,
  opts: { ttlSec?: number; watchdog?: boolean; client?: RedisLike } = {},
): Promise<T | undefined> {
  const client = opts.client ?? getRedis()
  const ttlSec = opts.ttlSec ?? DEFAULT_TTL_SEC
  const key = LOCK_PREFIX + name
  const token = randomUUID()

  // SET key <token> NX EX ttl —— 抢到返回 "OK"，已有持锁者返回 null
  const acquired = await client.set(key, token, "EX", ttlSec, "NX")
  if (acquired !== "OK") return undefined

  let timer: ReturnType<typeof setInterval> | undefined
  if (opts.watchdog) {
    const renewMs = Math.max(1000, Math.floor((ttlSec * 1000) / 3))
    timer = setInterval(() => {
      client
        .eval(RENEW_LUA, 1, key, token, String(ttlSec * 1000))
        .then((renewed) => {
          if (renewed === 0) {
            // 锁已易主（TTL 曾过期被他人抢走）：停止续租，别给别人的锁续命；本 fn 无法中断，靠业务幂等键兜底
            console.error(`[cron:${name}] 锁已易主，停止续租（instance=${instanceId}）`)
            clearInterval(timer)
          }
        })
        .catch((err) => console.error(`[cron:${name}] 续租失败`, err))
    }, renewMs)
    timer.unref?.()
  }

  try {
    return await fn()
  } finally {
    if (timer) clearInterval(timer)
    try {
      await client.eval(RELEASE_LUA, 1, key, token)
    } catch (err) {
      console.error(`[cron:${name}] 释放锁失败（等 TTL 自愈）`, err)
    }
  }
}

/**
 * 注册进程内 cron：注册时立即首跑一次 tick，之后每 everyMs 一次；每 tick 抢锁执行 jobFn（抢到才跑 = 分布式单例）。
 * 立即首跑是机制层收口：everyMs 为天级时，进程重启比周期更频繁会导致 setInterval 永远等不到首个到点
 * （每日对账/过期静默不跑）；首跑的重复触发由锁 + job 体业务幂等键天然去重。
 * 上一 tick 未结束时本 tick 跳过（自己持锁时 SET NX 也必失败，省一次往返）。
 * 单 tick 抛错吞掉记日志，不影响后续 tick（自愈）。stop() 清定时器并返回在途 tick 的 drain Promise，
 * 供停机时按 stopAll → 等 drain → closeRedis 的顺序收尾。
 */
export function registerCron(
  name: string,
  everyMs: number,
  jobFn: () => Promise<void>,
  opts: { client?: RedisLike; watchdog?: boolean } = {},
): { stop: () => Promise<void> } {
  let inflight: Promise<void> | undefined
  const tick = () => {
    if (inflight) return // 上一 tick 还在跑：跳过本次
    inflight = withCronLock(name, jobFn, { client: opts.client, watchdog: opts.watchdog })
      .catch((err) => console.error(`[cron:${name}] tick 失败`, err))
      .then(() => {
        inflight = undefined
      })
  }
  tick() // 立即首跑
  const timer = setInterval(tick, everyMs)
  timer.unref?.() // 不阻止进程退出（worker/api 主循环负责存活）
  return {
    stop: () => {
      clearInterval(timer)
      return inflight ?? Promise.resolve()
    },
  }
}

/** 一个待注册的 cron job（spec304 签到对账单 / spec305 提醒 / spec306 对账+积分过期 各自产出）。 */
export type CronJob = {
  name: string // 锁名，集群唯一
  everyMs: number // tick 间隔（注册时立即首跑一次，之后每 everyMs 触发）
  jobFn: () => Promise<void> // job 体：以 DB 为准查到期项、逐条幂等处理
  watchdog?: boolean // 长任务续租
}

/** worker/api 启动时批量注册全部 cron job；stopAll() 清全部定时器并等在途 job 收尾（优雅停机/测试）。 */
export function startCronRunner(jobs: CronJob[], opts: { client?: RedisLike } = {}): { stopAll: () => Promise<void> } {
  const handles = jobs.map((j) => registerCron(j.name, j.everyMs, j.jobFn, { client: opts.client, watchdog: j.watchdog }))
  return {
    stopAll: async () => {
      await Promise.all(handles.map((h) => h.stop()))
    },
  }
}
