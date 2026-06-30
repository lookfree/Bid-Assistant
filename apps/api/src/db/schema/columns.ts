import { uuid, timestamp } from "drizzle-orm/pg-core"

// 跨表共用列构造器（生成的 SQL 与逐表手写完全一致）。
export const id = () => uuid("id").primaryKey().defaultRandom()
export const tz = (name: string) => timestamp(name, { withTimezone: true })
export const createdAt = () => tz("created_at").notNull().defaultNow()
