import { getEnv, type Env } from "../../config/env"
import { makeTerminalService, type SqbTerminalConfig, type TerminalService } from "./terminal"
import { makeShouqianbaProvider } from "./shouqianba"
import type { PaymentProvider } from "./provider"

// 支付装配入口（唯一组装点：路由与入口 Cron 共用，凭据判定只有一处 → 不半开）。
// 凭据缺任一项返回 undefined，调用方整体跳过：入口不注册签到/扫单 Cron、路由 503 payment_unconfigured。

/** env 齐全才给终端配置；缺任一项视为未接入收钱吧。 */
export function sqbTerminalConfigFromEnv(env: Env = getEnv()): SqbTerminalConfig | undefined {
  const { SQB_VENDOR_SN, SQB_VENDOR_KEY, SQB_APP_ID, SQB_ACTIVATION_CODE, SQB_DEVICE_ID, TERMINAL_KEY_SECRET } = env
  if (!SQB_VENDOR_SN || !SQB_VENDOR_KEY || !SQB_APP_ID || !SQB_ACTIVATION_CODE || !SQB_DEVICE_ID || !TERMINAL_KEY_SECRET) return undefined
  return {
    gateway: env.SQB_GATEWAY,
    vendorSn: SQB_VENDOR_SN,
    vendorKey: SQB_VENDOR_KEY,
    appId: SQB_APP_ID,
    activationCode: SQB_ACTIVATION_CODE,
    deviceId: SQB_DEVICE_ID,
    keySecret: TERMINAL_KEY_SECRET,
  }
}

export type PaymentAssembly = { provider: PaymentProvider; terminal: TerminalService; baseUrl: string }

let cached: PaymentAssembly | undefined

/** 惰性单例：终端服务 + ShouqianbaProvider + 回调公网基址。
 *  gate 是完整集合（终端凭据 + 验签公钥 + PAYMENT_NOTIFY_BASE_URL）——缺公网基址会签出
 *  相对路径的 notify_url，回调永远到不了，属于「下单成功但确认通道残废」的半开状态，必须一起关。 */
export function getPayment(): PaymentAssembly | undefined {
  if (cached) return cached
  const env = getEnv()
  const cfg = sqbTerminalConfigFromEnv(env)
  if (!cfg || !env.SQB_PUBLIC_KEY || !env.PAYMENT_NOTIFY_BASE_URL) return undefined
  const terminal = makeTerminalService(cfg)
  const provider = makeShouqianbaProvider({
    cfg: {
      gateway: env.SQB_GATEWAY,
      publicKey: env.SQB_PUBLIC_KEY.replace(/\\n/g, "\n"), // env 里 PEM 以 \n 转义存放
    },
    getCredentials: () => terminal.getCredentials(),
  })
  return (cached = { provider, terminal, baseUrl: env.PAYMENT_NOTIFY_BASE_URL })
}
