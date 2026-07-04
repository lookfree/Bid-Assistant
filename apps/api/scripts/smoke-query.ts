// 冒烟：查询某笔 clientSn 的通道终态（付款后确认；对账/轮询同一 query 能力）。
// 用法：bun run scripts/smoke-query.ts <CLIENT_SN>
import { getPayment } from "../src/services/payment"
import { closeDb } from "../src/db/client"

const clientSn = process.argv[2]
if (!clientSn) {
  console.error("用法：bun run scripts/smoke-query.ts <CLIENT_SN>")
  process.exit(1)
}
const payment = getPayment()
if (!payment) {
  console.error("支付未装配")
  process.exit(1)
}
try {
  const r = await payment.provider.query(clientSn)
  console.log(`QUERY ${clientSn}:`, JSON.stringify(r))
} catch (e) {
  console.error("查询异常（可能通道尚无此单/未支付）:", (e as Error).message)
}
await closeDb()
