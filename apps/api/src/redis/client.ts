import Redis from "ioredis"
import { getEnv } from "../config/env"

// 惰性单例：首次使用才读 env、建连接，import 无副作用（与 db/client 一致）。
let client: Redis | undefined

export function getRedis(): Redis {
  if (!client) {
    const env = getEnv()
    client = new Redis({
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      password: env.REDIS_PASSWORD,
      db: env.REDIS_DB,
      keyPrefix: env.REDIS_KEY_PREFIX,
      maxRetriesPerRequest: 2,
    })
  }
  return client
}

// 优雅关闭：入口在 SIGINT/SIGTERM 时调用。
export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => client?.disconnect())
    client = undefined
  }
}
