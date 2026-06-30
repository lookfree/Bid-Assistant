import { and, eq, gt, isNull } from "drizzle-orm"
import { getDb } from "../db/client"
import { sessions, type Session } from "../db/schema"

export async function createSession(input: {
  userId: string
  tokenHash: string
  expiresAt: Date
  userAgent?: string
  ip?: string
}): Promise<Session> {
  const [row] = await getDb().insert(sessions).values(input).returning()
  if (!row) throw new Error("创建会话失败")
  return row
}

export async function findValidSession(
  tokenHash: string,
  now: Date = new Date(),
): Promise<Session | null> {
  const [row] = await getDb()
    .select()
    .from(sessions)
    .where(
      and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)),
    )
    .limit(1)
  return row ?? null
}

export async function revokeSession(id: string): Promise<void> {
  await getDb().update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, id))
}
