# spec303 · 定时任务调度（Redis 分布式单例 Cron） 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 **Redis 分布式单例 Cron**（架构 §6.4）：每个 App/worker 实例内置分钟级 tick，执行前抢 Redis 锁（`SET lock:cron:<name> <instanceId> NX EX 300`），抢到的实例独占执行 job、用 **Lua CAS** 只删自己持有的锁、长任务 watchdog 续租 → 保证集群内同一时刻**只有一个实例**在跑（分布式单例）。产出 `withCronLock` / `registerCron` / `startCronRunner` 三件套，供 spec305 到期提醒/订阅状态推进、spec306 对账+积分过期复用。不引入 Quartz/独立调度器（§6.4「简单」原则）。

**Architecture:** Redis 只负责「同一时刻单实例执行」，**DB 是「什么到期」的唯一真相**——job 体以 DB 为准查到期项、逐条幂等处理（业务幂等键兜底，双触发不重复扣款）。锁 TTL=300s 自愈：实例挂了锁自动过期，下一 tick 别的实例接管。`withCronLock` 抢锁→执行→Lua CAS 释放（值=instanceId，比对一致才 DEL，避免误删续期后别人抢到的锁）；可选 watchdog 在 fn 执行期间周期 `PEXPIRE` 续租。`registerCron(name, everyMs, jobFn)` 用 `setInterval` 起进程内 tick，每 tick 包一层 `withCronLock`。`startCronRunner(jobs)` 在 worker/api 启动时批量注册。**消费 Phase 0 的 ioredis 客户端**（`apps/api/src/redis/client.ts`，库 3、前缀 `bid:`）。

**Tech Stack:** Hono 4.12、Bun、Drizzle ORM、PostgreSQL（public schema）、ioredis、bun:test。

## Global Constraints

见 `spec300-index.md`。本 spec 关键：
- 周期任务统一走 **Redis 分布式单例 Cron**（§6.4），不引入独立调度器；**业务幂等键兜底**，双触发不重复扣款。
- 复用 Phase 0 的 ioredis 客户端 `apps/api/src/redis/client.ts`（`redis`，库 3）；锁键前缀经客户端统一加 `bid:`，本服务再加 `lock:cron:` → 最终键 `bid:lock:cron:<name>`。
- 锁释放**必须 Lua CAS**（GET 值 == instanceId 才 DEL），杜绝 TTL 过期后误删他人锁。
- **DB 为准**：job 体查到期项、逐条幂等；Redis 只保证单实例。锁 TTL=300s 自愈。
- 本 spec **不实现具体 job**（到期提醒/对账/过期分别在 spec305/306，收钱吧每日签到在 spec304），只提供调度器与一个示例注册；TDD；`main` 上先开分支。

---

## File Structure

```
apps/api/src/
├── services/cron.ts            # 新：withCronLock + registerCron + startCronRunner + instanceId
└── redis/client.ts             # 复用（Phase 0/spec004，已存在）：export const redis
apps/api/test/
├── cron-lock.test.ts           # 新：抢锁互斥 + Lua CAS 释放（mock ioredis）
└── cron-tick.test.ts           # 新：tick 周期触发 job（假定时器）
```

> 单测用 **mock ioredis**（不连真 Redis）：注入一个最小 `set`/`eval`/`pexpire` mock，验证调度语义；锁键/续租命令的真实连通性由 spec004 的 redis 冒烟测试覆盖，本 spec 不重复。

---

## Interfaces（本 spec 对外产出，供 spec304/305/306 注册签到、提醒、对账、过期 job）

- Produces：`apps/api/src/services/cron.ts`
  - `instanceId: string`（本进程唯一标识，模块加载时生成 `crypto.randomUUID()`）。
  - `withCronLock<T>(name: string, fn: () => Promise<T>, opts?: { ttlSec?: number; watchdog?: boolean; client?: RedisLike }) -> Promise<T | undefined>`
    抢锁 `SET lock:cron:<name> <instanceId> NX EX <ttl>`；抢到→执行 `fn`，结束 Lua CAS 释放；没抢到→返回 `undefined`（跳过）。`watchdog:true` 时 fn 执行期每 `ttl/3` 秒 `PEXPIRE` 续租。
  - `registerCron(name: string, everyMs: number, jobFn: () => Promise<void>, opts?: { client?: RedisLike }) -> { stop: () => void }`
    `setInterval(everyMs)` 起进程内 tick，每 tick 调 `withCronLock(name, jobFn)`（吞错并记日志，单 tick 失败不影响下一 tick）。
  - `startCronRunner(jobs: CronJob[], opts?: { client?: RedisLike }) -> { stopAll: () => void }`
    批量 `registerCron`；worker/api 启动时调用。
  - 类型：`type CronJob = { name: string; everyMs: number; jobFn: () => Promise<void>; watchdog?: boolean }`；`type RedisLike = Pick<Redis, "set" | "eval" | "pexpire">`（便于注入 mock）。

- Consumes：`apps/api/src/redis/client.ts` 的 `redis`（ioredis，Phase 0/spec004）。

---

## Task 1: withCronLock —— 抢锁互斥 + Lua CAS 释放

**Files:** Create `apps/api/src/services/cron.ts`、`apps/api/test/cron-lock.test.ts`

- [ ] **Step 1: 开分支**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout main
git checkout -b phase3/spec303-cron-scheduler
```

- [ ] **Step 2: 写 `services/cron.ts`（instanceId + withCronLock + Lua CAS）**

```typescript
import { randomUUID } from "node:crypto";
import { redis } from "../redis/client";
import type Redis from "ioredis";

/** 本进程唯一标识：锁的 value，用于 Lua CAS 只删自己持有的锁。 */
export const instanceId: string = randomUUID();

/** 仅依赖这三个命令，便于单测注入 mock。 */
export type RedisLike = Pick<Redis, "set" | "eval" | "pexpire">;

const LOCK_PREFIX = "lock:cron:"; // 经 ioredis keyPrefix("bid:") → 实际键 bid:lock:cron:<name>
const DEFAULT_TTL_SEC = 300;

/** Lua CAS：仅当锁值 == 本实例时才删，杜绝 TTL 过期后误删他人续期的锁。 */
const RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

/**
 * 抢锁执行：SET lock NX EX ttl 抢到 → 跑 fn → Lua CAS 释放；没抢到 → 返回 undefined（跳过）。
 * watchdog:true 时 fn 执行期每 ttl/3 秒 PEXPIRE 续租，防长任务锁过期被别人抢。
 */
export async function withCronLock<T>(
  name: string,
  fn: () => Promise<T>,
  opts: { ttlSec?: number; watchdog?: boolean; client?: RedisLike } = {},
): Promise<T | undefined> {
  const client = opts.client ?? (redis as unknown as RedisLike);
  const ttlSec = opts.ttlSec ?? DEFAULT_TTL_SEC;
  const key = LOCK_PREFIX + name;

  // SET key <instanceId> NX EX ttl —— 抢到返回 "OK"，没抢到返回 null
  const acquired = await client.set(key, instanceId, "EX", ttlSec, "NX");
  if (acquired !== "OK") return undefined; // 已有别的实例持锁 → 本 tick 跳过

  let timer: ReturnType<typeof setInterval> | undefined;
  if (opts.watchdog) {
    const renewMs = Math.max(1000, Math.floor((ttlSec * 1000) / 3));
    timer = setInterval(() => {
      // 续租：把锁 TTL 再拉回 ttl（仅本实例持锁期间生效）
      void client.pexpire(key, ttlSec * 1000);
    }, renewMs);
  }

  try {
    return await fn();
  } finally {
    if (timer) clearInterval(timer);
    // Lua CAS 释放：值匹配才删
    await client.eval(RELEASE_LUA, 1, key, instanceId);
  }
}
```

- [ ] **Step 3: 失败测试 `test/cron-lock.test.ts`（mock ioredis：set 返回 OK/null + Lua CAS 仅删自己）**

```typescript
import { expect, test, mock } from "bun:test";
import { withCronLock, instanceId, type RedisLike } from "../src/services/cron";

/** 最小 mock：set 按外部预设返回 OK 或 null；eval 模拟 Lua CAS（值匹配才删）。 */
function makeMock(setResult: "OK" | null) {
  const store = new Map<string, string>();
  const calls: { eval: any[][]; pexpire: any[][] } = { eval: [], pexpire: [] };
  if (setResult === "OK") store.set("lock:cron:job", instanceId);
  const client: RedisLike = {
    set: mock(async () => setResult) as any,
    eval: mock(async (_lua: string, _n: number, key: string, val: string) => {
      calls.eval.push([key, val]);
      if (store.get(key) === val) { store.delete(key); return 1; } // CAS 命中 → 删
      return 0;                                                     // 值不符 → 不删
    }) as any,
    pexpire: mock(async (...a: any[]) => { calls.pexpire.push(a); return 1; }) as any,
  };
  return { client, store, calls };
}

test("抢到锁 → 执行 fn → Lua CAS 删自己持有的锁", async () => {
  const { client, store, calls } = makeMock("OK");
  const ran = await withCronLock("job", async () => "done", { client });
  expect(ran).toBe("done");
  expect(store.has("lock:cron:job")).toBe(false);          // 锁已释放
  expect(calls.eval[0]).toEqual(["lock:cron:job", instanceId]); // CAS 用本实例值
});

test("没抢到锁 → 跳过(fn 不执行, 返回 undefined)", async () => {
  const { client } = makeMock(null);
  let executed = false;
  const ran = await withCronLock("job", async () => { executed = true; return "x"; }, { client });
  expect(ran).toBeUndefined();
  expect(executed).toBe(false);                            // 别的实例持锁 → 本实例不跑
});

test("Lua CAS：锁值是别人的 instanceId → 不删", async () => {
  const { client, store } = makeMock("OK");
  store.set("lock:cron:job", "OTHER-INSTANCE");            // 模拟续期后被他人持有
  await withCronLock("job", async () => "done", { client });
  expect(store.get("lock:cron:job")).toBe("OTHER-INSTANCE"); // 值不符 → 未误删
});

test("两实例并发抢同一锁，只有一个 fn 执行", async () => {
  let executed = 0;
  const winner = makeMock("OK");   // 实例 A 抢到
  const loser = makeMock(null);    // 实例 B 没抢到
  await Promise.all([
    withCronLock("dedup", async () => { executed++; }, { client: winner.client }),
    withCronLock("dedup", async () => { executed++; }, { client: loser.client }),
  ]);
  expect(executed).toBe(1);        // 集群内同一时刻单实例执行
});
```

- [ ] **Step 4: 通过 + 提交**

```bash
cd apps/api && bun test test/cron-lock.test.ts
git add apps/api/src/services/cron.ts apps/api/test/cron-lock.test.ts
git commit -m "feat(spec303): withCronLock(SET NX EX 抢锁 + Lua CAS 释放 + watchdog 续租)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: registerCron —— 分钟级 tick 周期触发

**Files:** Modify `apps/api/src/services/cron.ts`、Create `apps/api/test/cron-tick.test.ts`

- [ ] **Step 1: 在 `cron.ts` 加 `registerCron`（setInterval tick + 每 tick withCronLock）**

```typescript
/**
 * 注册一个进程内 cron：每 everyMs 起一次 tick，每 tick 抢锁执行 jobFn（抢到才跑 = 分布式单例）。
 * 单 tick 内 jobFn 抛错被吞掉并记日志，不影响后续 tick（自愈）。返回 stop() 清掉定时器。
 */
export function registerCron(
  name: string,
  everyMs: number,
  jobFn: () => Promise<void>,
  opts: { client?: RedisLike; watchdog?: boolean } = {},
): { stop: () => void } {
  const tick = async () => {
    try {
      await withCronLock(name, jobFn, { client: opts.client, watchdog: opts.watchdog });
    } catch (err) {
      console.error(`[cron:${name}] tick 失败`, err); // 吞错：下一 tick 继续
    }
  };
  const timer = setInterval(() => void tick(), everyMs);
  // 不阻止进程退出（worker/api 主循环负责存活）
  if (typeof timer === "object" && "unref" in timer) (timer as any).unref?.();
  return { stop: () => clearInterval(timer) };
}
```

- [ ] **Step 2: 失败测试 `test/cron-tick.test.ts`（假定时器：tick 周期触发 job）**

```typescript
import { expect, test, mock } from "bun:test";
import { registerCron, type RedisLike } from "../src/services/cron";

/** 永远抢到锁的 mock（验证 tick 触发语义）。 */
function lockingClient(): RedisLike {
  return {
    set: mock(async () => "OK") as any,
    eval: mock(async () => 1) as any,
    pexpire: mock(async () => 1) as any,
  };
}

test("registerCron 按 everyMs 周期触发 jobFn", async () => {
  const client = lockingClient();
  let runs = 0;
  const { stop } = registerCron("ticker", 20, async () => { runs++; }, { client });
  await new Promise((r) => setTimeout(r, 75)); // 75ms / 20ms ≈ 3 次 tick
  stop();
  const after = runs;
  expect(after).toBeGreaterThanOrEqual(2);     // 至少触发了 2 次
  await new Promise((r) => setTimeout(r, 40));
  expect(runs).toBe(after);                    // stop 后不再触发
});

test("某次 jobFn 抛错不影响后续 tick（吞错自愈）", async () => {
  const client = lockingClient();
  let runs = 0;
  const { stop } = registerCron("resilient", 20, async () => {
    runs++;
    if (runs === 1) throw new Error("第一次故意失败");
  }, { client });
  await new Promise((r) => setTimeout(r, 75));
  stop();
  expect(runs).toBeGreaterThanOrEqual(2);      // 第一次抛错后仍继续 tick
});
```

- [ ] **Step 3: 通过 + 提交**

```bash
cd apps/api && bun test test/cron-tick.test.ts
git add apps/api/src/services/cron.ts apps/api/test/cron-tick.test.ts
git commit -m "feat(spec303): registerCron(setInterval tick + 每 tick 抢锁执行, 吞错自愈)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: startCronRunner —— 启动时批量注册所有 job

**Files:** Modify `apps/api/src/services/cron.ts`、`apps/api/test/cron-tick.test.ts`

- [ ] **Step 1: 在 `cron.ts` 加 `CronJob` 类型 + `startCronRunner`**

```typescript
/** 一个待注册的 cron job 定义（spec304 签到、spec305 提醒/状态推进、spec306 对账/过期 各产出）。 */
export type CronJob = {
  name: string;                 // 锁名，集群唯一
  everyMs: number;              // tick 间隔（分钟级，如 60_000）
  jobFn: () => Promise<void>;   // job 体：以 DB 为准查到期项、逐条幂等处理
  watchdog?: boolean;           // 长任务续租
};

/**
 * worker/api 启动时调用：批量注册所有 cron job。
 * 返回 stopAll() 供优雅停机（测试/SIGTERM）清掉全部定时器。
 */
export function startCronRunner(
  jobs: CronJob[],
  opts: { client?: RedisLike } = {},
): { stopAll: () => void } {
  const handles = jobs.map((j) =>
    registerCron(j.name, j.everyMs, j.jobFn, { client: opts.client, watchdog: j.watchdog }),
  );
  return { stopAll: () => handles.forEach((h) => h.stop()) };
}
```

> spec305/306 落地时，在 worker 入口（如 `apps/api/src/worker.ts` 或启动脚本）这样用：
> ```typescript
> import { startCronRunner } from "./services/cron";
> import { autoRenewJob } from "./services/auto-renew";   // spec305 产出
> import { reconcileJob, expireCreditsJob } from "./services/reconcile"; // spec306 产出
> startCronRunner([
>   { name: "auto-renew",     everyMs: 60_000, jobFn: autoRenewJob },        // 每分钟扫 next_deduct_at
>   { name: "reconcile",      everyMs: 60_000, jobFn: reconcileJob, watchdog: true }, // 对账长任务续租
>   { name: "expire-credits", everyMs: 60_000, jobFn: expireCreditsJob },    // 扫 expire_at 写 expire
> ]);
> ```
> job 体内部以 DB 为准、逐条幂等（如提醒幂等键=订阅+周期末+档），即使锁异常双触发也不重复处理。

- [ ] **Step 2: 失败测试（startCronRunner 注册多 job 都触发, stopAll 全停）**

```typescript
import { startCronRunner, type RedisLike } from "../src/services/cron";

test("startCronRunner 注册多个 job 都按周期触发, stopAll 全停", async () => {
  const client: RedisLike = {
    set: mock(async () => "OK") as any,
    eval: mock(async () => 1) as any,
    pexpire: mock(async () => 1) as any,
  };
  const hits: Record<string, number> = { a: 0, b: 0 };
  const { stopAll } = startCronRunner([
    { name: "job-a", everyMs: 20, jobFn: async () => { hits.a++; } },
    { name: "job-b", everyMs: 20, jobFn: async () => { hits.b++; } },
  ], { client });
  await new Promise((r) => setTimeout(r, 75));
  stopAll();
  expect(hits.a).toBeGreaterThanOrEqual(2);    // job-a 多次触发
  expect(hits.b).toBeGreaterThanOrEqual(2);    // job-b 多次触发
  const snap = { ...hits };
  await new Promise((r) => setTimeout(r, 40));
  expect(hits).toEqual(snap);                  // stopAll 后全部停止
});
```

- [ ] **Step 3: 通过 + 提交**

```bash
cd apps/api && bun test test/cron-tick.test.ts
git add apps/api/src/services/cron.ts apps/api/test/cron-tick.test.ts
git commit -m "feat(spec303): startCronRunner(启动批量注册 CronJob + stopAll 优雅停机)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 全量回归 + 合并

**Files:** —

- [ ] **Step 1: 跑全量测试确认无回归**

```bash
cd apps/api && bun test test/cron-lock.test.ts test/cron-tick.test.ts
```

Expected: 全部 PASS（抢锁互斥 / Lua CAS / tick 周期 / startCronRunner / stopAll）。

- [ ] **Step 2: 合并回 main**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout main
git merge --no-ff phase3/spec303-cron-scheduler -m "merge spec303: Redis 分布式单例 Cron(withCronLock/registerCron/startCronRunner)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push origin main
```

---

## 验收清单（spec303）

- [ ] `instanceId` 进程唯一（`crypto.randomUUID()`），作为锁 value。
- [ ] `withCronLock` 用 `SET lock:cron:<name> <instanceId> NX EX 300` 抢锁；抢到执行 fn，没抢到返回 `undefined` 跳过。
- [ ] 两实例并发抢同一锁，**只有一个** fn 执行（mock `set` 返回 OK/null 验证）。
- [ ] 释放用 **Lua CAS**：值 == instanceId 才 DEL；值是别人的 instanceId **不误删**。
- [ ] `watchdog:true` 时 fn 执行期周期 `PEXPIRE` 续租（长任务不丢锁）。
- [ ] `registerCron` 用 `setInterval` 按 everyMs **周期触发** jobFn，每 tick 包 `withCronLock`；单 tick 抛错被吞、不影响后续 tick（自愈）；`stop()` 后不再触发。
- [ ] `startCronRunner(jobs)` 批量注册，`stopAll()` 全停；接口可供 spec304 签到 / spec305 提醒 / spec306 对账+过期注册 job。
- [ ] 消费 Phase 0 ioredis 客户端（`apps/api/src/redis/client.ts`，库 3、前缀 `bid:`）；锁实际键 `bid:lock:cron:<name>`。
- [ ] `bun test` 全绿。
