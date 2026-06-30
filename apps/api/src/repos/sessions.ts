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
  return row! // insert ... returning 成功必返一行
}

// 有效会话判定（鉴权关键）：token 命中 且 未撤销(revoked_at IS NULL) 且 未过期(expires_at > now)，
// 三者同时成立才算有效——撤销或过期任一即失效。
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
