import { getEnv, type Env } from "../../config/env"
import { makeTerminalService, type SqbTerminalConfig, type TerminalService } from "./terminal"
import { makeShouqianbaProvider } from "./shouqianba"
import type { PaymentProvider } from "./provider"

// 支付装配入口：env → 终端服务 + Provider（默认收钱吧）。凭据缺失的环境返回 undefined，
// 由调用方决定跳过（入口不注册签到 Cron、路由返回 payment_unconfigured）。

const WAP_GATEWAY_DEFAULT = "https://qr.shouqianba.com/gateway"

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

let cached: { provider: PaymentProvider; terminal: TerminalService } | undefined

/** 惰性单例：终端服务 + ShouqianbaProvider；未配置返回 undefined。 */
export function getPayment(env: Env = getEnv()): { provider: PaymentProvider; terminal: TerminalService } | undefined {
  if (cached) return cached
  const cfg = sqbTerminalConfigFromEnv(env)
  if (!cfg || !env.SQB_PUBLIC_KEY) return undefined
  const terminal = makeTerminalService(cfg)
  const provider = makeShouqianbaProvider({
    cfg: {
      gateway: env.SQB_GATEWAY,
      wapGateway: WAP_GATEWAY_DEFAULT,
      publicKey: env.SQB_PUBLIC_KEY.replace(/\\n/g, "\n"), // env 里 PEM 以 \n 转义存放
    },
    getCredentials: () => terminal.getCredentials(),
  })
  return (cached = { provider, terminal })
}
