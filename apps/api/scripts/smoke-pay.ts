// 冒烟：生成 1 分钱跳转支付 URL（收钱吧生产网关，真实交易）。
// 用法：bun run scripts/smoke-pay.ts
//   → 打印 CLIENT_SN 与 PAY_URL；把 PAY_URL 转二维码/在手机打开付款；再跑 smoke-query.ts 确认。
import { randomUUID } from "node:crypto"
import { getPayment } from "../src/services/payment"
import { getEnv } from "../src/config/env"
import { closeDb } from "../src/db/client"

const payment = getPayment()
if (!payment) {
  console.error("支付未装配：SQB_* / TERMINAL_KEY_SECRET / PAYMENT_NOTIFY_BASE_URL 缺项")
  process.exit(1)
}
const base = getEnv().PAYMENT_NOTIFY_BASE_URL ?? ""
const clientSn = `smoke-${randomUUID()}`
const { payUrl } = await payment.provider.createPayment({
  clientSn,
  amountCents: 1, // 1 分钱
  subject: "投标助手冒烟测试",
  returnUrl: `${base}/pay/result?sn=${clientSn}`,
  notifyUrl: `${base}/api/payment/shouqianba/notify`,
})
console.log(`CLIENT_SN=${clientSn}`)
console.log(`PAY_URL=${payUrl}`)
await closeDb()
