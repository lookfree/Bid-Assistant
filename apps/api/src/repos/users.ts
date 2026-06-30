import { and, eq } from "drizzle-orm"
import { getDb } from "../db/client"
import { users, userIdentities, type User, type IdentityProvider } from "../db/schema"
import { IdentityAlreadyBoundError, isUniqueViolation } from "./errors"

export async function getUserById(id: string): Promise<User | null> {
  const [row] = await getDb().select().from(users).where(eq(users.id, id)).limit(1)
  return row ?? null
}

export async function findUserByIdentity(
  provider: IdentityProvider,
  identifier: string,
): Promise<User | null> {
  const [row] = await getDb()
    .select()
    .from(users)
    .innerJoin(userIdentities, eq(userIdentities.userId, users.id))
    .where(and(eq(userIdentities.provider, provider), eq(userIdentities.identifier, identifier)))
    .limit(1)
  return row?.users ?? null
}

export async function createUserWithIdentity(input: {
  provider: IdentityProvider
  identifier: string
  verifiedAt?: Date
  nickname?: string
  termsAgreedAt?: Date
}): Promise<User> {
  try {
    // 事务内原子建 user + identity；identity 撞 UNIQUE(provider,identifier) 时整体回滚。
    return await getDb().transaction(async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({ nickname: input.nickname, termsAgreedAt: input.termsAgreedAt })
        .returning()
      if (!u) throw new Error("创建用户失败")
      await tx.insert(userIdentities).values({
        userId: u.id,
        provider: input.provider,
        identifier: input.identifier,
        verifiedAt: input.verifiedAt,
      })
      return u
    })
  } catch (e) {
    if (isUniqueViolation(e)) throw new IdentityAlreadyBoundError(input.provider, input.identifier)
    throw e
  }
}

export async function addIdentity(
  userId: string,
  provider: IdentityProvider,
  identifier: string,
  verifiedAt?: Date,
): Promise<void> {
  try {
    await getDb().insert(userIdentities).values({ userId, provider, identifier, verifiedAt })
  } catch (e) {
    // 身份已被占用 → 抛领域错误，调用方据此返回“已绑定”而非 500。
    if (isUniqueViolation(e)) throw new IdentityAlreadyBoundError(provider, identifier)
    throw e
  }
}
