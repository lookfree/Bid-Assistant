import { eq, sql } from "drizzle-orm"
import { getDb } from "../db/client"
import { billingConfigs } from "../db/schema"
import { BILLING_SEED } from "../config/billing-seed"

// billing_configs 读写：单一权威键值表。
// 开发只读 + 种子写；运营后台（spec310）经 setConfig 改值即生效。

// 读单个配置值（未配置返回 undefined，调用方自决兜底）。
export async function getConfig<T = unknown>(key: string): Promise<T | undefined> {
  const [row] = await getDb().select().from(billingConfigs).where(eq(billingConfigs.key, key))
  return row?.value as T | undefined
}

// 按前缀批量读配置（如 "credit_cost."），不传前缀返回全表；返回 {key: value}。
export async function getConfigs(prefix?: string): Promise<Record<string, unknown>> {
  // LIKE 通配符转义：prefix 是字面前缀，% _ \ 不作通配
  const escaped = prefix?.replace(/[\\%_]/g, (m) => `\\${m}`)
  const rows = escaped
    ? await getDb()
        .select()
        .from(billingConfigs)
        .where(sql`${billingConfigs.key} like ${escaped + "%"}`)
    : await getDb().select().from(billingConfigs)
  return Object.fromEntries(rows.map((r) => [r.key, r.value]))
}

// 种子：仅写不存在的 key（绝不覆盖运营已改的值）；单条批量插入
export async function seedConfigs(): Promise<void> {
  const rows = Object.entries(BILLING_SEED).map(([key, value]) => ({ key, value }))
  await getDb().insert(billingConfigs).values(rows).onConflictDoNothing({ target: billingConfigs.key })
}

// 运营改配置（spec310 后台用）：upsert 同一张表
export async function setConfig(key: string, value: unknown): Promise<void> {
  await getDb()
    .insert(billingConfigs)
    .values({ key, value })
    .onConflictDoUpdate({ target: billingConfigs.key, set: { value, updatedAt: new Date() } })
}
