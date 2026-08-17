import { randomBytes } from "node:crypto"
import type { Redis } from "ioredis"
import { findUserByIdentity, createOrGetOnConflict, addIdentity, getUserPhone, getUserById } from "../repos/users"
import { IdentityAlreadyBoundError } from "../repos/errors"
import { mintSession, TermsRequiredError, AccountBannedError, InvalidCodeError, applySignupBonus } from "./auth"
import type { WechatOAuthClient } from "./wechat-oauth"
import type { User } from "../db/schema"

/** state 无效/已过期/已用（CSRF 暂存未命中），或绑定态已消费/超时。 */
export class InvalidStateError extends Error {
  constructor() {
    super("invalid_state")
    this.name = "InvalidStateError"
  }
}

/** 要绑的手机号已属于另一个账号，而当前微信号自己也已有账号——跨账号合并涉及积分，不自动做。 */
export class PhoneTakenError extends Error {
  constructor() {
    super("phone_taken")
    this.name = "PhoneTakenError"
  }
}

type BindPayload = { identifier: string; nickname?: string; agreedToTerms: boolean; userId?: string }
type LoginMeta = { userAgent?: string; ip?: string }
type Session = { token: string; user: User; isNew: boolean }

/** 微信登录结果：要么已是绑过手机号的老账号（直接发会话），要么进绑定态（等手机号）。 */
export type WechatLoginResult = { needBindPhone: true; bindToken: string } | ({ needBindPhone?: false } & Session)

const BIND_TTL_SECONDS = 600

export function makeWechatAuth(redis: Redis, oauth: WechatOAuthClient, ttlDays: number) {
  const bindKey = (t: string) => `wxbind:${t}`

  // 绑定后发会话的共用尾巴。注册赠分不在这里——见 attach()：赠分必须紧跟建号，
  // 否则建号之后、发会话之前的任何一步抛错，用户就落下一个永远拿不到 200 分的号。
  async function finish(user: User, isNew: boolean, meta: LoginMeta): Promise<Session> {
    const token = await mintSession(user.id, meta, ttlDays)
    return { token, user, isNew }
  }

  return {
    // 建 CSRF state（含协议同意位），落 Redis，TTL 10 分钟、一次性。
    async createState(agreedToTerms: boolean): Promise<string> {
      const state = randomBytes(16).toString("hex")
      await redis.set(`wxstate:${state}`, JSON.stringify({ agreedToTerms }), "EX", 600)
      return state
    },

    // code+state 换登录：校验并消费 state → 换取微信身份 →
    // 2026-08-17 起「必须绑手机号」：没有手机号的微信身份**不建号、不发会话**，只回一次性绑定态。
    async login(code: string, state: string, meta: LoginMeta): Promise<WechatLoginResult> {
      const raw = await redis.getdel(`wxstate:${state}`) // 原子读取并消费（一次性，避免 get/del 竞态）
      if (!raw) throw new InvalidStateError()
      const { agreedToTerms } = JSON.parse(raw) as { agreedToTerms: boolean }

      const profile = await oauth.exchangeCode(code)
      const identifier = profile.unionid ?? profile.openid // 优先 unionid（开放平台跨应用稳定）

      const user = await findUserByIdentity("wechat", identifier)
      if (user?.status === "banned") throw new AccountBannedError() // 封禁账号不得经微信重登（与手机号同一拦截）
      if (user && (await getUserPhone(user.id))) return await finish(user, false, meta)
      // 新号必须先同意协议——在发绑定态之前判定，别让用户填完手机号才被拒。
      if (!user && !agreedToTerms) throw new TermsRequiredError()

      const bindToken = randomBytes(32).toString("hex")
      const payload: BindPayload = { identifier, nickname: profile.nickname, agreedToTerms, userId: user?.id }
      await redis.set(bindKey(bindToken), JSON.stringify(payload), "EX", BIND_TTL_SECONDS)
      return { needBindPhone: true, bindToken }
    },

    // 绑手机号完成登录：短信验证码即手机号所有权证明。
    // 验证码错**不作废**绑定态（否则一次填错就得重扫码），绑成功才消费。
    async bindPhone(
      bindToken: string,
      phone: string,
      meta: LoginMeta,
      consumeCode: () => Promise<"ok" | "expired" | "mismatch" | "too_many">,
    ): Promise<Session> {
      const raw = await redis.get(bindKey(bindToken))
      if (!raw) throw new InvalidStateError()
      const payload = JSON.parse(raw) as BindPayload

      const existing = await findUserByIdentity("phone", phone)
      if (existing?.status === "banned") throw new AccountBannedError() // 消费码前判定，一次性码不被烧
      if (existing && payload.userId && existing.id !== payload.userId) throw new PhoneTakenError()

      const result = await consumeCode()
      if (result !== "ok") throw new InvalidCodeError(result)
      if (!(await redis.getdel(bindKey(bindToken)))) throw new InvalidStateError() // 并发两个请求只放行一个

      const { user, isNew } = await attach(payload, phone, existing)
      return await finish(user, isNew, meta)
    },
  }
}

/** 定账号归属：老微信号补绑 / 手机号已有账号则挂靠 / 都没有才建号（与短信注册同一条建号路径）。 */
async function attach(
  payload: BindPayload,
  phone: string,
  existing: User | null,
): Promise<{ user: User; isNew: boolean }> {
  if (payload.userId) {
    if (existing) return { user: existing, isNew: false } // 已是同一账号（重复绑定），幂等返回
    await addIdentity(payload.userId, "phone", phone, new Date())
    const user = await getUserById(payload.userId)
    if (!user) throw new InvalidStateError() // 账号在绑定途中被删，当绑定态失效处理
    return { user, isNew: false }
  }
  if (existing) {
    await bindWechat(existing.id, payload.identifier)
    return { user: existing, isNew: false } // 挂靠既有手机号账号：不新建，积分不分裂
  }
  const created = await createOrGetOnConflict({
    provider: "phone",
    identifier: phone,
    verifiedAt: new Date(),
    nickname: payload.nickname,
    termsAgreedAt: new Date(),
  })
  // 首次注册赠积分（与手机号注册同一入口，best-effort）。紧跟建号：挂微信身份若失败，
  // 用户手上仍是一个正常且已赠分的手机号账号。
  if (created.isNew) await applySignupBonus(created.user.id)
  await bindWechat(created.user.id, payload.identifier)
  return created
}

// 先手机号建号、再挂微信身份（两步非原子）。顺序是刻意的：万一挂微信失败，用户手上是一个
// 正常的手机号账号，下次短信登录即可；反过来会留下一个登不进去、也绑不了的孤儿微信号。
// 该微信身份已被别人占用时不能静默吞掉——它意味着这次扫码的归属不明。
async function bindWechat(userId: string, identifier: string): Promise<void> {
  try {
    await addIdentity(userId, "wechat", identifier, new Date())
  } catch (e) {
    if (e instanceof IdentityAlreadyBoundError) throw new PhoneTakenError()
    throw e
  }
}
