import { and, eq, gt, isNull } from "drizzle-orm"
import { getDb } from "../db/client"
import { adminSessions, type AdminSession } from "../db/schema"

// admin 会话仓储（spec309，独立于 C 端 sessions；只存 token 的 sha256）。

export async function createAdminSession(input: {
  adminId: string
  tokenHash: string
  expiresAt: Date
}): Promise<AdminSession> {
  const [row] = await getDb().insert(adminSessions).values(input).returning()
  return row!
}

export async function findValidAdminSession(tokenHash: string, now: Date = new Date()): Promise<AdminSession | null> {
  const [row] = await getDb()
    .select()
    .from(adminSessions)
    .where(and(eq(adminSessions.tokenHash, tokenHash), isNull(adminSessions.revokedAt), gt(adminSessions.expiresAt, now)))
    .limit(1)
  return row ?? null
}

export async function revokeAdminSession(id: string): Promise<void> {
  await getDb().update(adminSessions).set({ revokedAt: new Date() }).where(eq(adminSessions.id, id))
}
