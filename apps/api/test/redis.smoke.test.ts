import { describe, it, expect, afterAll } from "bun:test"
import { getRedis, closeRedis } from "../src/redis/client"

afterAll(() => closeRedis())

describe("redis", () => {
  it("set/get/del roundtrip on db3", async () => {
    const redis = getRedis()
    const k = `smoke:${Date.now()}`
    await redis.set(k, "v", "EX", 10)
    expect(await redis.get(k)).toBe("v")
    await redis.del(k)
    expect(await redis.get(k)).toBeNull()
  })
})
