// 一次性运维脚本：激活收钱吧终端（terminal_sn/terminal_key 加密落库，集群共享）。
// 用法（读 .env.bidsaas.local 的 SQB_* 与 TERMINAL_KEY_SECRET）：
//   bun --env-file=../../.env.bidsaas.local run scripts/activate-terminal.ts
// 重复执行安全：重新激活覆盖旧凭证（terminal.activate 内 upsert）。
import { sqbTerminalConfigFromEnv } from "../src/services/payment"
import { makeTerminalService } from "../src/services/payment/terminal"
import { closeDb } from "../src/db/client"

const cfg = sqbTerminalConfigFromEnv()
if (!cfg) {
  console.error("SQB_VENDOR_SN/SQB_VENDOR_KEY/SQB_APP_ID/SQB_ACTIVATION_CODE/SQB_DEVICE_ID/TERMINAL_KEY_SECRET 不齐，无法激活")
  process.exit(1)
}
const sn = await makeTerminalService(cfg).activate()
console.log(`终端激活成功 terminal_sn=${sn}（device_id=${cfg.deviceId}）`)
await closeDb()
