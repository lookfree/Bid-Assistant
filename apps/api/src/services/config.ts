import { eq, sql } from "drizzle-orm"
import { getDb } from "../db/client"
import { billingConfigs } from "../db/schema"
import { BILLING_SEED } from "../config/billing-seed"

// billing_configs 读写：单一权威键值表。开发只读 + 种子写；运营后台（spec310）经 setConfig 改值即生效。

export async function getConfig<T = unknown>(key: string): Promise<T | undefined> {
  const [row] = await getDb().select().from(billingConfigs).where(eq(billingConfigs.key, key))
  return row?.value as T | undefined
}

export async function getConfigs(prefix?: string): Promise<Record<string, unknown>> {
  const rows = prefix
    ? await getDb()
        .select()
        .from(billingConfigs)
        .where(sql`${billingConfigs.key} like ${prefix + "%"}`)
    : await getDb().select().from(billingConfigs)
  return Object.fromEntries(rows.map((r) => [r.key, r.value]))
}

// 种子：仅写不存在的 key（绝不覆盖运营已改的值）
export async function seedConfigs(): Promise<void> {
  for (const [key, value] of Object.entries(BILLING_SEED)) {
    await getDb().insert(billingConfigs).values({ key, value }).onConflictDoNothing({ target: billingConfigs.key })
  }
}

// 运营改配置（spec310 后台用）：upsert 同一张表
export async function setConfig(key: string, value: unknown): Promise<void> {
  await getDb()
    .insert(billingConfigs)
    .values({ key, value })
    .onConflictDoUpdate({ target: billingConfigs.key, set: { value, updatedAt: new Date() } })
}
