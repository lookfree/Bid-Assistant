import CaptchaClient, { VerifyIntelligentCaptchaRequest } from "@alicloud/captcha20230305"
import { Config as OpenApiConfig } from "@alicloud/openapi-client"
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

// 适配接口：只暴露我们用到的那一个方法，隔离阿里云 SDK 具体形态、便于单测传 fake（不在测试里 new 真 SDK）。
export interface IntelligentCaptchaClient {
  verifyIntelligentCaptcha(param: {
    sceneId: string
    captchaVerifyParam: string
  }): Promise<{ verifyResult: boolean }>
}

export class AliyunCaptchaVerifier implements CaptchaVerifier {
  constructor(
    private client: IntelligentCaptchaClient,
    private sceneId: string,
  ) {}

  async verify(token?: string): Promise<boolean> {
    if (!token) return false // 开启滑块却没滑/无 param → 判负，且不调用阿里云
    try {
      const r = await this.client.verifyIntelligentCaptcha({
        sceneId: this.sceneId,
        captchaVerifyParam: token,
      })
      return r.verifyResult === true // 只有明确通过才放行
    } catch {
      return false // fail-closed：网络/鉴权异常绝不放行（宁可让真人重滑）
    }
  }
}

// 把阿里云 SDK 响应形态（res.body.result.verifyResult）翻译成干净的 IntelligentCaptchaClient 接口，
// 校验器本身不依赖 SDK 类型；字段缺失一律判负、不抛。
function makeSdkAdapter(client: CaptchaClient): IntelligentCaptchaClient {
  return {
    async verifyIntelligentCaptcha({ sceneId, captchaVerifyParam }) {
      const res = await client.verifyIntelligentCaptcha(
        new VerifyIntelligentCaptchaRequest({ sceneId, captchaVerifyParam }),
      )
      return { verifyResult: res?.body?.result?.verifyResult === true }
    },
  }
}

/**
 * 工厂（三态）：
 *  - 有阿里云验证码凭据 → 返回真实滑块校验器 AliyunCaptchaVerifier（VerifyIntelligentCaptcha）。
 *  - 无凭据 + 生产 + 已开启 → 抛错（fail-closed，绝不在生产静默放行）。
 *  - 无凭据 + 非生产 → DevPass（放行 + 告警）。
 */
export function createCaptchaVerifier(env: Env): CaptchaVerifier {
  const hasCreds =
    !!env.ALIYUN_CAPTCHA_ACCESS_KEY_ID &&
    !!env.ALIYUN_CAPTCHA_ACCESS_KEY_SECRET &&
    !!env.ALIYUN_CAPTCHA_SCENE_ID
  if (hasCreds) {
    const client = new CaptchaClient(
      new OpenApiConfig({
        accessKeyId: env.ALIYUN_CAPTCHA_ACCESS_KEY_ID,
        accessKeySecret: env.ALIYUN_CAPTCHA_ACCESS_KEY_SECRET,
        endpoint: env.ALIYUN_CAPTCHA_ENDPOINT,
      }),
    )
    return new AliyunCaptchaVerifier(makeSdkAdapter(client), env.ALIYUN_CAPTCHA_SCENE_ID!)
  }
  if (env.CAPTCHA_ENABLED && env.NODE_ENV === "production") {
    throw new Error(
      "[captcha] 生产已开启滑块但缺少阿里云验证码凭据——拒绝静默放行，请配置或显式关闭 CAPTCHA_ENABLED",
    )
  }
  console.warn("[captcha] 无滑块凭据，开发期放行（DevPass）；生产前请按 spec004.1 接入阿里云验证码2.0")
  return new DevPassCaptchaVerifier()
}
