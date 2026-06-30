import Dysmsapi, { SendSmsRequest } from "@alicloud/dysmsapi20170525"
import { Config as OpenApiConfig } from "@alicloud/openapi-client"
import type { Env } from "../config/env"

export interface SmsSender {
  send(phone: string, code: string): Promise<void>
}

/** 开发期：不真发短信，打印到控制台 */
export class FakeSmsSender implements SmsSender {
  async send(phone: string, code: string): Promise<void> {
    console.log(`[FakeSMS] -> ${phone} 验证码 ${code}`)
  }
}

export class AliyunSmsSender implements SmsSender {
  private client: Dysmsapi
  constructor(
    private cfg: {
      accessKeyId: string
      accessKeySecret: string
      signName: string
      templateCode: string
    },
  ) {
    this.client = new Dysmsapi(
      new OpenApiConfig({
        accessKeyId: cfg.accessKeyId,
        accessKeySecret: cfg.accessKeySecret,
        endpoint: "dysmsapi.aliyuncs.com",
      }),
    )
  }
  async send(phone: string, code: string): Promise<void> {
    const req = new SendSmsRequest({
      phoneNumbers: phone.replace(/^\+86/, ""),
      signName: this.cfg.signName,
      templateCode: this.cfg.templateCode,
      templateParam: JSON.stringify({ code }),
    })
    const res = await this.client.sendSms(req)
    if (res.body?.code !== "OK") {
      throw new Error(`阿里云短信发送失败: ${res.body?.code} ${res.body?.message}`)
    }
  }
}

export function createSmsSender(env: Env): SmsSender {
  const id = env.ALIYUN_SMS_ACCESS_KEY_ID
  const secret = env.ALIYUN_SMS_ACCESS_KEY_SECRET
  const signName = env.ALIYUN_SMS_SIGN_NAME
  const templateCode = env.ALIYUN_SMS_TEMPLATE_CODE
  if (id && secret && signName && templateCode) {
    return new AliyunSmsSender({ accessKeyId: id, accessKeySecret: secret, signName, templateCode })
  }
  console.warn("[sms] 阿里云短信凭据缺失，使用 FakeSmsSender（仅开发期）")
  return new FakeSmsSender()
}
