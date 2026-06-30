import { and, eq } from "drizzle-orm"
import { getDb } from "../db/client"
import { users, userIdentities, type User, type IdentityProvider } from "../db/schema"

export async function getUserById(id: string): Promise<User | null> {
  const [row] = await getDb().select().from(users).where(eq(users.id, id)).limit(1)
  return row ?? null
}

export async function findUserByIdentity(
  provider: IdentityProvider,
  identifier: string,
): Promise<User | null> {
  const [row] = await getDb()
    .select({ u: users })
    .from(userIdentities)
    .innerJoin(users, eq(userIdentities.userId, users.id))
    .where(and(eq(userIdentities.provider, provider), eq(userIdentities.identifier, identifier)))
    .limit(1)
  return row?.u ?? null
}

export async function createUserWithIdentity(input: {
  provider: IdentityProvider
  identifier: string
  verifiedAt?: Date
  nickname?: string
  termsAgreedAt?: Date
}): Promise<User> {
  return getDb().transaction(async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({ nickname: input.nickname ?? null, termsAgreedAt: input.termsAgreedAt ?? null })
      .returning()
    if (!u) throw new Error("创建用户失败")
    await tx.insert(userIdentities).values({
      userId: u.id,
      provider: input.provider,
      identifier: input.identifier,
      verifiedAt: input.verifiedAt ?? null,
    })
    return u
  })
}

export async function addIdentity(
  userId: string,
  provider: IdentityProvider,
  identifier: string,
  verifiedAt?: Date,
): Promise<void> {
  await getDb()
    .insert(userIdentities)
    .values({ userId, provider, identifier, verifiedAt: verifiedAt ?? null })
}
