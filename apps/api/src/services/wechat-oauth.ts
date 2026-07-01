import type { Env } from "../config/env"

export type WechatProfile = { openid: string; unionid?: string; nickname?: string; avatar?: string }

export interface WechatOAuthClient {
  exchangeCode(code: string): Promise<WechatProfile>
}

// 微信 OAuth HTTP 响应（错误时带 errcode/errmsg，成功时无 errcode）。
type WxTokenResp = {
  errcode?: number
  errmsg?: string
  access_token?: string
  openid?: string
  unionid?: string
}
type WxUserInfoResp = { errcode?: number; nickname?: string; headimgurl?: string; unionid?: string }

/** 真实：微信网站应用 OAuth2（简单 HTTP，无需 SDK）。仅在配置了凭据时使用。 */
export class RealWechatOAuthClient implements WechatOAuthClient {
  constructor(
    private cfg: { appId: string; appSecret: string },
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async exchangeCode(code: string): Promise<WechatProfile> {
    const tokUrl =
      `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${this.cfg.appId}` +
      `&secret=${this.cfg.appSecret}&code=${encodeURIComponent(code)}&grant_type=authorization_code`
    const tok = (await (await this.fetchImpl(tokUrl)).json()) as WxTokenResp
    if (tok.errcode || !tok.access_token || !tok.openid) {
      throw new Error(`wechat oauth token: ${tok.errcode ?? "no_token"} ${tok.errmsg ?? ""}`)
    }
    let nickname: string | undefined
    let avatar: string | undefined
    let unionid: string | undefined = tok.unionid
    try {
      const ui = (await (
        await this.fetchImpl(
          `https://api.weixin.qq.com/sns/userinfo?access_token=${tok.access_token}&openid=${tok.openid}`,
        )
      ).json()) as WxUserInfoResp
      if (!ui.errcode) {
        nickname = ui.nickname
        avatar = ui.headimgurl
        unionid = ui.unionid ?? unionid
      }
    } catch {
      /* userinfo 失败不阻断登录 */
    }
    return { openid: tok.openid, unionid, nickname, avatar }
  }
}

/** 开发：无凭据时返回确定性伪身份，便于端到端联调。 */
export class DevWechatOAuthClient implements WechatOAuthClient {
  async exchangeCode(code: string): Promise<WechatProfile> {
    return { openid: `dev_open_${code}`, unionid: `dev_union_${code}`, nickname: "微信用户(dev)" }
  }
}

// 三态工厂：有凭据→真实；无凭据+生产→fail-closed 抛错；无凭据+非生产→开发伪实现。
export function createWechatOAuthClient(env: Env): WechatOAuthClient {
  if (env.WECHAT_APP_ID && env.WECHAT_APP_SECRET) {
    return new RealWechatOAuthClient({ appId: env.WECHAT_APP_ID, appSecret: env.WECHAT_APP_SECRET })
  }
  if (env.NODE_ENV === "production") {
    throw new Error("[wechat] 生产缺少微信开放平台凭据（WECHAT_APP_ID/SECRET）")
  }
  console.warn("[wechat] 无微信凭据，开发期用 DevWechatOAuthClient（伪 openid）")
  return new DevWechatOAuthClient()
}
