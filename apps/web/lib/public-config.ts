import { api } from "./api"

export type PublicConfig = { signupGrantCredits: number }

/** 公开配置（免鉴权）：注册赠送积分等可公开展示值。未登录页（首页）也可拉；
 *  相对路径经 nginx 代理到 API，失败由调用方回退默认值。 */
export function fetchPublicConfig(): Promise<PublicConfig> {
  return api.request<PublicConfig>("/api/public/config")
}
