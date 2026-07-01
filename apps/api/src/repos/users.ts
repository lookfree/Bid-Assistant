import { and, eq } from "drizzle-orm"
import { getDb } from "../db/client"
import { users, userIdentities, type User, type IdentityProvider } from "../db/schema"
import { mapIdentityConflict, IdentityAlreadyBoundError } from "./errors"

type NewIdentityUser = {
  provider: IdentityProvider
  identifier: string
  verifiedAt?: Date
  nickname?: string
  termsAgreedAt?: Date
}

export async function getUserById(id: string): Promise<User | null> {
  const [row] = await getDb().select().from(users).where(eq(users.id, id)).limit(1)
  return row ?? null
}

export async function findUserByIdentity(
  provider: IdentityProvider,
  identifier: string,
): Promise<User | null> {
  // 投影只取 users 列，避免把 user_identities 整行一起拉过公网。
  const [row] = await getDb()
    .select({ user: users })
    .from(users)
    .innerJoin(userIdentities, eq(userIdentities.userId, users.id))
    .where(and(eq(userIdentities.provider, provider), eq(userIdentities.identifier, identifier)))
    .limit(1)
  return row?.user ?? null
}

export async function createUserWithIdentity(input: NewIdentityUser): Promise<User> {
  // 事务内原子建 user + identity；identity 撞 UNIQUE(provider,identifier) 时整体回滚并翻译成领域错误。
  return mapIdentityConflict(input.provider, input.identifier, () =>
    getDb().transaction(async (tx) => {
      const [created] = await tx
        .insert(users)
        .values({ nickname: input.nickname, termsAgreedAt: input.termsAgreedAt })
        .returning()
      const user = created! // insert ... returning 成功必返一行
      await tx.insert(userIdentities).values({
        userId: user.id,
        provider: input.provider,
        identifier: input.identifier,
        verifiedAt: input.verifiedAt,
      })
      return user
    }),
  )
}

// 建号；并发首登竞态（两个请求都过了 null 检查、都建号）时输者撞 UNIQUE(provider,identifier)，
// 取胜者已建的行。isNew 反映是否本次真的创建（竞态输者为 false）。找/建后 mint 会话由调用方负责。
export async function createOrGetOnConflict(input: NewIdentityUser): Promise<{ user: User; isNew: boolean }> {
  try {
    return { user: await createUserWithIdentity(input), isNew: true }
  } catch (e) {
    if (e instanceof IdentityAlreadyBoundError) {
      const winner = await findUserByIdentity(input.provider, input.identifier)
      if (winner) return { user: winner, isNew: false }
    }
    throw e
  }
}

export async function addIdentity(
  userId: string,
  provider: IdentityProvider,
  identifier: string,
  verifiedAt?: Date,
): Promise<void> {
  await mapIdentityConflict(provider, identifier, () =>
    getDb().insert(userIdentities).values({ userId, provider, identifier, verifiedAt }),
  )
}
