import { mock } from "bun:test"
import type { RedisLike } from "../../src/services/cron"

/**
 * cron 用 ioredis mock（cron-lock / cron-tick 共用，不连真 Redis）：
 * - set：按预设返回 OK（抢到，真写 store）或 null（没抢到）；
 * - eval：模拟两段 Lua CAS——值匹配才 del（释放）/ pexpire 续租（脚本含 "del" 视为释放）。
 * 断言用 bun mock 自带的 .mock.calls（set 的第 2 参 = 本次持锁 token）。
 */
export function makeRedisMock(setResult: "OK" | null) {
  const store = new Map<string, string>()
  const set = mock(async (key: string, val: string) => {
    if (setResult === "OK") store.set(key, val)
    return setResult
  })
  const evalFn = mock(async (lua: string, _numKeys: number, key: string, token: string) => {
    if (store.get(key) !== token) return 0 // CAS 不命中：不删也不续
    if (lua.includes(`"del"`)) store.delete(key)
    return 1
  })
  return {
    client: { set, eval: evalFn } as unknown as RedisLike,
    store,
    set,
    eval: evalFn,
    /** 续租类 eval 调用（脚本含 pexpire）。 */
    renewCalls: () => evalFn.mock.calls.filter(([lua]) => String(lua).includes("pexpire")),
  }
}
