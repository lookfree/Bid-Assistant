import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { getEnv } from "../config/env"
import * as schema from "./schema"

// 惰性单连接池：首次使用时才读 env、建池，import 本身无副作用（与 env.ts 的惰性一致），
// 这样在没有 DATABASE_URL 的测试/工具上下文里 import 本模块不会校验环境或开连接。
let client: ReturnType<typeof postgres> | undefined
let database: PostgresJsDatabase<typeof schema> | undefined

function getClient() {
  return (client ??= postgres(getEnv().DATABASE_URL, { max: 10 }))
}

export function getDb() {
  return (database ??= drizzle(getClient(), { schema }))
}

export async function pingDb(): Promise<boolean> {
  try {
    await getClient()`select 1` // 走原生 client，跳过 drizzle 查询层
    return true
  } catch {
    return false
  }
}

// 优雅关闭：入口在 SIGINT/SIGTERM 时调用，归还连接，避免 --watch 热重载/重启泄漏连接。
export async function closeDb(): Promise<void> {
  if (client) {
    await client.end({ timeout: 5 })
    client = undefined
    database = undefined
  }
}
