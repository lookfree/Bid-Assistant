import { drizzle } from "drizzle-orm/postgres-js"
import { sql } from "drizzle-orm"
import postgres from "postgres"
import { getEnv } from "../config/env"

// 单连接池；schema 在 spec003 引入并作为第二参数传入 drizzle()
const client = postgres(getEnv().DATABASE_URL, { max: 10 })
export const db = drizzle(client)

export async function pingDb(): Promise<boolean> {
  try {
    await db.execute(sql`select 1`)
    return true
  } catch {
    return false
  }
}
