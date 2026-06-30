import type { Env } from "../config/env"

export interface CaptchaVerifier {
  verify(token?: string): Promise<boolean>
}

/** 开发期放行：凭据缺失时用，恒通过（仅非生产）。 */
export class DevPassCaptchaVerifier implements CaptchaVerifier {
  async verify(): Promise<boolean> {
    return true
  }
}

/**
 * 工厂（三态）：
 *  - 有阿里云验证码凭据 → 返回真实滑块校验器（spec004.1 接入 @alicloud/captcha20230305 后在此分支返回）。
 *  - 无凭据 + 生产 + 已开启 → 抛错（fail-closed，绝不在生产静默放行）。
 *  - 无凭据 + 非生产 → DevPass（放行 + 告警）。
 */
export function createCaptchaVerifier(env: Env): CaptchaVerifier {
  const hasCreds =
    !!env.ALIYUN_CAPTCHA_ACCESS_KEY_ID &&
    !!env.ALIYUN_CAPTCHA_ACCESS_KEY_SECRET &&
    !!env.ALIYUN_CAPTCHA_SCENE_ID
  if (hasCreds) {
    throw new Error(
      "[captcha] 已配置阿里云验证码凭据，但真实滑块校验器尚未接入——见 spec004.1（接入 @alicloud/captcha20230305 VerifyIntelligentCaptcha）",
    )
  }
  if (env.CAPTCHA_ENABLED && env.NODE_ENV === "production") {
    throw new Error(
      "[captcha] 生产已开启滑块但缺少阿里云验证码凭据——拒绝静默放行，请配置或显式关闭 CAPTCHA_ENABLED",
    )
  }
  console.warn("[captcha] 无滑块凭据，开发期放行（DevPass）；生产前请按 spec004.1 接入阿里云验证码2.0")
  return new DevPassCaptchaVerifier()
}
