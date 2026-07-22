import { randomBytes } from "node:crypto"
import { findUserByIdentity, createOrGetOnConflict, getUserById } from "../repos/users"
import { bindByCode } from "./referral"
import { InvalidCodeError as RefInvalidCodeError, SelfReferralError, DuplicateInviteeError } from "./referral-errors"
import { createSession, findValidSession, revokeSession } from "../repos/sessions"
import { sha256Hex } from "./crypto"
import { grant } from "./credits"
import { getConfig, pickNonNegative } from "./config"
import type { User } from "../db/schema"

// 首次注册一次性赠送积分默认额度（运营后台 billing_configs.signup_grant_credits 可覆盖）。
const SIGNUP_GRANT_DEFAULT = 200

/** 首次注册赠送积分：额度读 signup_grant_credits（缺省 200，≤0 或非法则不发）；
 *  幂等键 `signup_grant:<userId>` 保证每用户仅发一次；有效期走 grant_expire_days（0=不过期）。 */
async function grantSignupBonus(userId: string): Promise<void> {
  const amount = Number((await getConfig("signup_grant_credits")) ?? SIGNUP_GRANT_DEFAULT)
  if (!Number.isFinite(amount) || amount <= 0) return
  // pickNonNegative 而非 ||：配置 0 是合法值（不过期），|| 会把 0 吞成缺省。
  // 缺键兜底必须与种子默认(0)和后台展示兜底(0)一致，否则后台显示"不过期"实际却发 30 天过期
  const days = pickNonNegative(await getConfig("grant_expire_days"), 0)
  await grant(userId, amount, {
    type: "grant",
    sourceBatch: "signup",
    ref: "signup_bonus",
    expireAt: days > 0 ? new Date(Date.now() + days * 86_400_000) : undefined,
    idempotencyKey: `signup_grant:${userId}`,
  })
}

/** 首次注册赠送积分（best-effort）：手机号/微信首登共用；失败只记日志，绝不阻断注册。 */
export async function applySignupBonus(userId: string): Promise<void> {
  try {
    await grantSignupBonus(userId)
  } catch (e) {
    console.error(`[auth] 注册赠送积分异常（不阻断注册）user=${userId}`, e)
  }
}

// 会话令牌只以 sha256 哈希入库（sessions.token_hash）；原始不透明令牌只发给客户端，DB 不留明文。
// createSession 与 findValidSession 两侧必须用同一哈希（与 admin 共用 sha256Hex，防漂移）。
export function hashToken(token: string): string {
  return sha256Hex(token)
}

/** 签发 32 字节不透明令牌，DB 只存其 sha256 哈希；落 sessions（可撤销）。手机号/微信等各登录方式共用。 */
export async function mintSession(
  userId: string,
  meta: { userAgent?: string; ip?: string },
  ttlDays: number,
): Promise<string> {
  const token = randomBytes(32).toString("hex")
  await createSession({
    userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + ttlDays * 86_400_000),
    userAgent: meta.userAgent,
    ip: meta.ip,
  })
  return token
}

/** 未注册手机号需先同意协议才会自动建号；否则拒绝（注册即登录）。 */
export class TermsRequiredError extends Error {
  constructor() {
    super("terms_required")
    this.name = "TermsRequiredError"
  }
}

/** 验证码错误/已失效。 */
export class InvalidCodeError extends Error {
  constructor() {
    super("invalid_code")
    this.name = "InvalidCodeError"
  }
}

/**
 * 手机号验证码登录（即注册）。顺序很关键：
 *  1. 先判“新用户是否需同意协议”——在消费验证码之前，避免 terms_required 把一次性码烧掉；
 *  2. 再消费验证码（一次性）；错码抛 InvalidCodeError；
 *  3. 新用户则建号，并捕获并发首登竞态（另一请求已建号 → 取胜者）；
 *  4. 签发 32 字节不透明令牌，DB 只存其 sha256 哈希。
 */
export async function loginWithPhone(
  phone: string,
  meta: { userAgent?: string; ip?: string; agreedToTerms?: boolean; referralCode?: string; deviceHash?: string },
  ttlDays: number,
  consumeCode: () => Promise<boolean>,
): Promise<{ token: string; user: User; isNew: boolean }> {
  let user = await findUserByIdentity("phone", phone)
  if (!user && !meta.agreedToTerms) throw new TermsRequiredError() // 消费码前判定，码不被烧
  if (!(await consumeCode())) throw new InvalidCodeError()
  let isNew = false
  if (!user) {
    const created = await createOrGetOnConflict({
      provider: "phone",
      identifier: phone,
      verifiedAt: new Date(),
      termsAgreedAt: new Date(),
    })
    user = created.user
    isNew = created.isNew
  }
  const token = await mintSession(user.id, meta, ttlDays)
  // 首次注册赠送积分（配置驱动，默认 200；手机号/微信首登共用同一入口）。
  if (isNew) await applySignupBonus(user.id)
  // R1：首次注册且带邀请码 → 绑定推荐关系（spec307 引擎的注册入口）。
  // 坏码/自荐/重复绑定/风控冻结都不得阻断注册，故吞错只留日志。deviceHash/ip 由路由服务端派生（R2）。
  if (isNew && meta.referralCode) {
    try {
      await bindByCode({ code: meta.referralCode, inviteeId: user.id, phone, deviceHash: meta.deviceHash, ip: meta.ip })
    } catch (e) {
      // 预期（坏码/自荐/重复绑定）是正常场景，静默；非预期（DB 故障/真 bug）醒目日志供告警——但都不阻断注册。
      const expected = e instanceof RefInvalidCodeError || e instanceof SelfReferralError || e instanceof DuplicateInviteeError
      if (!expected) console.error(`[auth] 推荐绑定异常（非预期，需排查；不阻断注册）invitee=${user.id}`, e)
    }
  }
  return { token, user, isNew }
}

/** 鉴权信任边界：token → 有效会话（未撤销未过期）→ User；任一不成立返回 null。 */
export async function resolveUserFromToken(token: string): Promise<User | null> {
  const session = await findValidSession(hashToken(token))
  if (!session) return null
  return getUserById(session.userId)
}

export async function logout(token: string): Promise<void> {
  const session = await findValidSession(hashToken(token))
  if (session) await revokeSession(session.id)
}
