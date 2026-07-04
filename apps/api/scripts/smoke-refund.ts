// 冒烟：对某笔 clientSn 全额退款（refundSn 幂等）。用法：bun run scripts/smoke-refund.ts <CLIENT_SN> <amountCents>
import { randomUUID } from "node:crypto"
import { getPayment } from "../src/services/payment"
import { closeDb } from "../src/db/client"

const clientSn = process.argv[2]
const amountCents = Number(process.argv[3] ?? "1")
if (!clientSn) {
  console.error("用法：bun run scripts/smoke-refund.ts <CLIENT_SN> <amountCents>")
  process.exit(1)
}
const payment = getPayment()
if (!payment) {
  console.error("支付未装配")
  process.exit(1)
}
const refundSn = `rf${Date.now().toString(36)}${randomUUID().slice(0, 8)}` // ≤32 字符
console.log(`REFUND_SN=${refundSn}`)
const r = await payment.provider.refund({ clientSn, refundSn, amountCents })
console.log("REFUND_RESULT=" + JSON.stringify(r))
await closeDb()
