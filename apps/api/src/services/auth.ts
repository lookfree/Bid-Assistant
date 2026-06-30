import { randomBytes, createHash } from "node:crypto"
import { findUserByIdentity, createUserWithIdentity, getUserById } from "../repos/users"
import { createSession, findValidSession, revokeSession } from "../repos/sessions"
import type { User } from "../db/schema"

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/** 未注册手机号需先同意协议才会自动建号；否则拒绝。 */
export class TermsRequiredError extends Error {
  constructor() {
    super("terms_required")
    this.name = "TermsRequiredError"
  }
}

export async function loginWithPhone(
  phone: string,
  meta: { userAgent?: string; ip?: string; agreedToTerms?: boolean },
  ttlDays: number,
): Promise<{ token: string; user: User; isNew: boolean }> {
  let user = await findUserByIdentity("phone", phone)
  let isNew = false
  if (!user) {
    // 验证码登录即注册：首次必须带协议同意
    if (!meta.agreedToTerms) throw new TermsRequiredError()
    user = await createUserWithIdentity({
      provider: "phone",
      identifier: phone,
      verifiedAt: new Date(),
      termsAgreedAt: new Date(),
    })
    isNew = true
  }
  const token = randomBytes(32).toString("hex")
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000)
  await createSession({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
    userAgent: meta.userAgent,
    ip: meta.ip,
  })
  return { token, user, isNew }
}

export async function resolveUserFromToken(token: string): Promise<User | null> {
  const session = await findValidSession(hashToken(token))
  if (!session) return null
  return getUserById(session.userId)
}

export async function logout(token: string): Promise<void> {
  const session = await findValidSession(hashToken(token))
  if (session) await revokeSession(session.id)
}
