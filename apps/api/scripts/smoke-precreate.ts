// 探针：C扫B 预下单 /upay/v2/precreate 的真实契约（app_id=C扫B支付）。
// 预下单不动钱，返回 qr_code 供顾客扫。用法：bun run scripts/smoke-precreate.ts [payway]
import { randomUUID } from "node:crypto"
import { getEnv } from "../src/config/env"
import { sqbTerminalConfigFromEnv } from "../src/services/payment"
import { makeTerminalService } from "../src/services/payment/terminal"
import { sqbPost } from "../src/services/payment/gateway"
import { closeDb } from "../src/db/client"

const env = getEnv()
const cfg = sqbTerminalConfigFromEnv()
if (!cfg) {
  console.error("SQB 配置不齐")
  process.exit(1)
}
const { terminalSn, terminalKey } = await makeTerminalService(cfg).getCredentials()
const clientSn = `sm${Date.now().toString(36)}${randomUUID().slice(0, 8)}` // ≤32 字符（收钱吧限制）
const payway = process.argv[2] ?? "1" // 1=支付宝 3=微信
const payload: Record<string, string> = {
  terminal_sn: terminalSn,
  client_sn: clientSn,
  total_amount: "1",
  subject: "投标助手冒烟测试",
  payway,
  operator: "smoke",
  notify_url: `${env.PAYMENT_NOTIFY_BASE_URL}/api/payment/shouqianba/notify`,
}
console.log(`CLIENT_SN=${clientSn}`)
try {
  const json = await sqbPost(fetch, env.SQB_GATEWAY, "/upay/v2/precreate", payload, terminalSn, terminalKey)
  console.log(JSON.stringify(json, null, 2))
} catch (e) {
  console.error("precreate 异常:", (e as Error).message)
}
await closeDb()
