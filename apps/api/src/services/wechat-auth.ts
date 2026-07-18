import { randomBytes } from "node:crypto"
import type { Redis } from "ioredis"
import { findUserByIdentity, createOrGetOnConflict } from "../repos/users"
import { mintSession, TermsRequiredError, applySignupBonus } from "./auth"
import type { WechatOAuthClient } from "./wechat-oauth"
import type { User } from "../db/schema"

/** state 无效/已过期/已用（CSRF 暂存未命中）。 */
export class InvalidStateError extends Error {
  constructor() {
    super("invalid_state")
    this.name = "InvalidStateError"
  }
}

export function makeWechatAuth(redis: Redis, oauth: WechatOAuthClient, ttlDays: number) {
  return {
    // 建 CSRF state（含协议同意位），落 Redis，TTL 10 分钟、一次性。
    async createState(agreedToTerms: boolean): Promise<string> {
      const state = randomBytes(16).toString("hex")
      await redis.set(`wxstate:${state}`, JSON.stringify({ agreedToTerms }), "EX", 600)
      return state
    },

    // code+state 换登录：校验并消费 state → 换取微信身份 → 按 unionid（缺失退 openid）找/建号 → 签发会话。
    async login(
      code: string,
      state: string,
      meta: { userAgent?: string; ip?: string },
    ): Promise<{ token: string; user: User; isNew: boolean }> {
      const raw = await redis.getdel(`wxstate:${state}`) // 原子读取并消费（一次性，避免 get/del 竞态）
      if (!raw) throw new InvalidStateError()
      const { agreedToTerms } = JSON.parse(raw) as { agreedToTerms: boolean }

      const profile = await oauth.exchangeCode(code)
      const identifier = profile.unionid ?? profile.openid // 优先 unionid（开放平台跨应用稳定）

      let user = await findUserByIdentity("wechat", identifier)
      let isNew = false
      if (!user) {
        if (!agreedToTerms) throw new TermsRequiredError()
        const created = await createOrGetOnConflict({
          provider: "wechat",
          identifier,
          verifiedAt: new Date(),
          nickname: profile.nickname,
          termsAgreedAt: new Date(),
        })
        user = created.user
        isNew = created.isNew
      }
      const token = await mintSession(user.id, meta, ttlDays)
      // 微信首次登录=首次注册，同手机号一样赠送积分（best-effort，不阻断登录）。
      if (isNew) await applySignupBonus(user.id)
      return { token, user, isNew }
    },
  }
}
