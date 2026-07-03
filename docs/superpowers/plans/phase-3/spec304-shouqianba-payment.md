# spec304 · 支付抽象 + 收钱吧单笔支付（充值 / 购买会员，架构 §6.0/§6.1）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地架构 §6.0/§6.1 的**收钱吧 C 扫 B 跳转支付**全链路：`PaymentProvider` 接口 + `ShouqianbaProvider`（终端激活/每日签到、WAP2 跳转支付 URL、查询、退款、回调 RSA 验签），以及充值/购买的下单 → 回调/轮询入账路由（`POST /api/payment/recharge`、`POST /api/payment/shouqianba/notify`、`GET /api/payment/orders/:id`）。下单建 `payment_orders`（status=created，client_sn 全局唯一）→ 拼跳转支付 URL 转二维码 → 用户微信/支付宝扫码付款 → **回调验签 + 轮询查询双通道**取终态 → 订单状态机置 paid（只一次）→ 调 spec302 `credits.grant({type:"purchase"})` 入账。**幂等关键**：回调可能重复、且与轮询并发，按收钱吧 `sn` + 订单状态机保证**只入账一次**；轮询窗口用尽仍无终态 → 订单置 `unknown` 待对账（spec306 清算）。

**Architecture:** 支付层是 `PaymentProvider` 抽象（屏蔽通道差异），现行实现 `ShouqianbaProvider`；未来换通道只加实现、不动路由。收钱吧无 SDK：HTTPS+JSON 直连网关 `https://vsi-api.shouqianba.com`。**两套签名**：非支付接口（激活/签到/查询/退款）`Authorization: sn + " " + MD5(body + key)`（激活用 vendor 参数，其余用 terminal 参数）；跳转支付（WAP2）用「参数 ASCII 升序 `&` 拼接 + `&key=` + terminal_key 的 MD5 大写」。**终端凭证生命周期**：激活码 + device_id → 激活得 terminal_sn/terminal_key（落 `payment_terminals`，集群共享）→ 每日签到轮换 terminal_key（spec303 Cron 注册；签到失败保留旧 key 重试，极端情况重激活）。钱只在 App API 动（§3.2）；金额单位统一**分**。生产网关即真实交易：联调用**测试激活码**（对应测试商户号），支付后即退款。

**Tech Stack:** Hono 4.12、Bun、Drizzle ORM、PostgreSQL（public schema）、Zod、`node:crypto`（MD5 签名 + SHA256WithRSA 验签，无第三方支付依赖）、bun:test。

## Global Constraints

见 `spec300-index.md`。本 spec 关键（**资金正确性铁律，逐条有测试**）：
- **钱只在 App API 动**（§3.2）：下单、验签、改订单状态、入账全在 App 层。
- **服务端定价**：客户端只传 `packId`/`planId`，**金额一律由服务端从配置取并快照进订单**；任何来自客户端的金额字段一律忽略。
- **金额一致性校验**：markPaid 前必须校验回调/查询返回的实付金额 == 订单快照金额（分），不一致 → 不入账、置 `amount_mismatch` 告警并进对账队列。
- **金额只用整数分**：全链路 integer，禁止浮点/元字符串参与计算（仅展示层格式化）。
- **状态机唯一赢家**：`created → paid` 用条件 UPDATE（`WHERE status='created'`）原子推进，回调与轮询并发时只有一个赢家入账。
- **接口事实以官方文档为准**：本计划只固化已从收钱吧资料（`docs/收钱吧接口文档`，含 C 扫 B-PRO 最佳实践 V1.6.6 + 回调签名方案 + 验收 xlsx）实证的机制（网关域名/两套签名/轮询节奏/终端生命周期/RSA 验签）；具体端点路径与字段名开发时对照 doc.shouqianba.com 线上文档，不在设计文档里臆造。
- **上线前配合收钱吧验收**（资料含官方验收用例 xlsx）：异常流程（重复回调/掉线/超时/退款）逐项过。
- **回调必须验签**：用收钱吧公钥做 `SHA256WithRSA` 验签（`Authorization` 头带 Base64 签名，body 原文为被签内容）；验签失败一律拒绝、不改任何状态。
- **幂等**：回调与轮询并发/重复 → 按 `provider_trade_no(sn)` + 订单状态机**只入账一次**；`grant` 用订单维度幂等键（`purchase:<orderId>`，spec302 唯一约束兜底）。
- **轮询规范**（收钱吧官方）：从跳转起订单有效期 4 分钟；0–1 分钟每 3s、1–5 分钟每 10s、第 6 分钟最后一次；仍无终态置 `unknown`（不置 failed——钱可能已付）。窗口/频率读 `billing_configs.payment_poll`。
- **凭证安全**：vendor_sn/vendor_key/app_id/激活码/收钱吧公钥全走 **env**（`.env.bidsaas.local`），不入库不进 git；terminal_key 加密落库（AES，密钥走 env）。
- **X-Forwarded-For**：支付相关请求向收钱吧透传顾客手机真实公网 IP（监管要求）；跳转支付 URL 由顾客手机直接访问收钱吧，天然满足。
- 金额单位统一**分**（`amount_cents` integer）；积分 integer。充值到账以命中 `recharge_packs` 项的 `credits` 为准（下单时快照）。
- TDD（`bun test`，mock 网关不打真实网络）；集成测试走 `./test-on-mbp.sh`；`main` 上先开分支 `phase3/spec304-shouqianba-payment`。

---

## File Structure

```
apps/api/src/
├── services/payment/
│   ├── provider.ts           # 新：PaymentProvider 接口 + 类型（createPayment/query/refund/verifyCallback）
│   ├── shouqianba.ts         # 新：ShouqianbaProvider（网关 HTTP + 两套签名 + 验签）
│   ├── shouqianba-sign.ts    # 新：MD5 body 签名 / WAP2 参数签名 / RSA 回调验签（纯函数，单测友好）
│   ├── terminal.ts           # 新：终端服务（activate/checkin + payment_terminals 读写 + key 加解密）
│   └── index.ts              # 新：getPaymentProvider()（默认 shouqianba）
├── routes/payment.ts         # 新：POST /recharge、POST /shouqianba/notify、GET /orders/:id
├── services/payment-orders.ts# 新：订单服务（createOrder 幂等、markPaid 状态机只一次、pollUntilFinal）
└── config/env.ts             # 改：加 SQB_VENDOR_SN/SQB_VENDOR_KEY/SQB_APP_ID/SQB_ACTIVATION_CODE/
                              #     SQB_GATEWAY(默认 vsi-api.shouqianba.com)/SQB_PUBLIC_KEY/SQB_DEVICE_ID/TERMINAL_KEY_SECRET
apps/api/test/
├── shouqianba-sign.test.ts   # 新：两套签名 + RSA 验签纯函数单测（官方样例向量）
├── payment-terminal.test.ts  # 新：激活/签到（mock 网关）→ payment_terminals 落库/轮换
├── payment-orders.test.ts    # 新：下单幂等 / markPaid 只一次 / 轮询窗口置 unknown
└── payment-routes.test.ts    # 新：recharge 返回支付 URL / notify 验签→paid+grant 一次 / 重复 notify 不重复 grant / 假签名拒绝
```

---

## Interfaces

- **Consumes（上游已产出）**：
  - 表（spec301）：`paymentOrders`（含 `clientSn/providerTradeNo/channelTradeNo/payway/status(created/paid/failed/unknown/refunded)`）、`paymentTerminals`、`refunds`。
  - 配置（spec301）：`getConfig("recharge_packs")`、`getConfig("payment_poll")`、`getConfig("grant_expire_days")`。
  - 账本（spec302）：`grant(userId, amount, {type:"purchase", ref, idempotencyKey, expireAt?})`。
  - Cron（spec303）：`registerCron("sqb-checkin", daily, ...)`（每日签到轮换 terminal_key）。
  - 鉴权（Phase 0）：`authMiddleware`。
- **Produces（供 spec305/306/308/310 依赖）**：
  - `PaymentProvider` 接口 + `getPaymentProvider()`；`ShouqianbaProvider.query/refund`（spec306 对账/退款复用）。
  - 订单服务 `createOrder(userId, type, amountCents, snapshot)` / `markPaid(orderId, {sn, tradeNo, payway})`（状态机，spec305 续费复用）/ `pollUntilFinal(orderId)`。
  - 路由 `POST /api/payment/recharge`、`POST /api/payment/shouqianba/notify`、`GET /api/payment/orders/:id`（spec308 会员中心调）。

### `PaymentProvider` 形态（Task 2 落地，此处为契约）

```typescript
export type PaymentResult = { status: "paid" | "failed" | "pending"; sn?: string; tradeNo?: string; payway?: string }

export interface PaymentProvider {
  /** 生成顾客扫码的跳转支付 URL（前端转二维码）。amountCents 分；clientSn 我方订单号 */
  createPayment(opts: { clientSn: string; amountCents: number; subject: string; returnUrl: string; notifyUrl: string }): Promise<{ payUrl: string }>
  /** 查询交易终态（轮询/对账共用） */
  query(clientSn: string): Promise<PaymentResult>
  /** 退款（支持部分退款；refundSn 幂等） */
  refund(opts: { clientSn: string; refundSn: string; amountCents: number }): Promise<{ ok: boolean }>
  /** 回调验签：body 原文 + Authorization 头签名 → 布尔 */
  verifyCallback(rawBody: string, authorization: string): boolean
}
```

---

## Task 1: 签名/验签纯函数 + 终端服务（激活/签到）

**Files:** Create `services/payment/shouqianba-sign.ts`、`services/payment/terminal.ts`；Modify `config/env.ts`；Create `test/shouqianba-sign.test.ts`、`test/payment-terminal.test.ts`

- [ ] **Step 1: 开分支** `git checkout -b phase3/spec304-shouqianba-payment`
- [ ] **Step 2: 失败测试 `shouqianba-sign.test.ts`** —— ① `md5BodySign(body, key)` 输出 = MD5(body+key) hex；② `wap2Sign(params, terminalKey)`：ASCII 升序拼 `k=v&…&key=<terminalKey>` 的 MD5 **大写**，剔除 sign/sign_type/空值；③ `verifyRsaCallback(body, sign, publicKey)`：用测试密钥对自签自验通过、篡改 body 失败。
- [ ] **Step 3: 实现 `shouqianba-sign.ts`**（`node:crypto`：`createHash("md5")`、`createVerify("RSA-SHA256")`+Base64）→ 测试通过。
- [ ] **Step 4: 失败测试 `payment-terminal.test.ts`** —— mock fetch：`activate()`（vendor 签名，body 含 app_id/code/device_id；**端点路径以收钱吧线上接口文档为准**：doc.shouqianba.com「激活」）→ 落 `payment_terminals`（terminal_key AES 加密）；`checkin()`（terminal 签名，「签到」接口）→ 更新 terminal_key + last_checkin_at；签到失败保留旧 key 不写坏。
- [ ] **Step 5: 实现 `terminal.ts`** + env 变量（`SQB_*`、`TERMINAL_KEY_SECRET`）→ 通过。注册每日签到 Cron（spec303 `registerCron`，锁内执行）。
- [ ] **Step 6: 提交** `feat(spec304): shouqianba signing + terminal activate/checkin`

## Task 2: ShouqianbaProvider（createPayment/query/refund/verifyCallback）

**Files:** Create `services/payment/provider.ts`、`services/payment/shouqianba.ts`、`services/payment/index.ts`；Create（并入）`test/payment-provider` 断言到 `payment-routes.test.ts` 或独立文件

- [ ] **Step 1: 失败测试** —— mock 网关：`createPayment` 生成的 payUrl 含 terminal_sn/client_sn/total_amount/return_url/notify_url 且 `sign` 可用 `wap2Sign` 复算一致；`query` 解析 `order_status/status/sn/trade_no/payway` 组合成 PaymentResult（PAID→paid、CANCELED/EXPIRED→failed、CREATED→pending）；`refund` 带 refund_request_no 幂等；`verifyCallback` 直通 Task 1 纯函数。
- [ ] **Step 2: 实现** `shouqianba.ts`（终端参数从 `terminal.ts` 取；非支付接口 `Authorization: terminal_sn + " " + md5BodySign(...)`）→ 通过。
- [ ] **Step 3: 提交** `feat(spec304): ShouqianbaProvider (pay url/query/refund/callback verify)`

## Task 3: 订单服务 + 路由（下单 → 回调/轮询 → 入账）

**Files:** Create `services/payment-orders.ts`、`routes/payment.ts`；Modify `src/app.ts` 挂载；Create `test/payment-orders.test.ts`、`test/payment-routes.test.ts`

- [ ] **Step 1: 失败测试 `payment-orders.test.ts`** —— `createOrder` 幂等键重复返回同单；`markPaid` 仅 `created→paid` 时入账一次（并发/重复调用第二次为 no-op）；`pollUntilFinal` 按配置窗口轮询（注入 fake timer/provider），窗口尽头无终态置 `unknown`。
- [ ] **Step 2: 实现订单服务**（状态机原子推进：`UPDATE ... WHERE status='created'` 返回行数判定唯一赢家；paid 后 `grant({type:"purchase", idempotencyKey: "purchase:"+orderId})`）。
- [ ] **Step 3: 失败测试 `payment-routes.test.ts`** —— `POST /recharge {packId}`：校验 pack、建单、返回 `{orderId, payUrl}`；`POST /shouqianba/notify`：验签失败 403 不改状态；验签成功但**金额与订单不符 → 不入账、标 mismatch**；验签+金额通过 → markPaid + grant；**重复 notify 只 grant 一次**；回调与轮询并发只入账一次（条件 UPDATE 单赢家断言）；`GET /orders/:id` 本人可查。
- [ ] **Step 4: 实现路由** + 挂载 `app.route("/api/payment", paymentRoutes())`（依赖可注入 mock，沿用 projects.ts 模式）→ 通过。
- [ ] **Step 5: 提交** `feat(spec304): payment routes (recharge -> pay url -> notify/poll -> grant)`

## Task 4: 真实冒烟（测试激活码）+ 合并

- [ ] **Step 1: 测试激活码端到端**（mbp）：激活 → 签到 → 建 1 分钱订单 → 手机扫码真实支付 → 回调/轮询置 paid → grant 入账 → 调退款接口退回。**收钱吧生产环境交易真实，冒烟金额用 1 分且必退款。**
- [ ] **Step 2: 全量 + 合并** `./test-on-mbp.sh` 全绿 → merge `phase3/spec304-shouqianba-payment` → push。

---

## 验收清单（spec304）

- [ ] 两套签名 + RSA 回调验签纯函数正确（含官方样例/自签向量）。
- [ ] 终端激活/每日签到落 `payment_terminals`（key 加密、集群共享、签到失败不写坏旧 key）。
- [ ] `PaymentProvider` 抽象 + `ShouqianbaProvider` 四方法；未来换通道只加实现。
- [ ] 下单 → 跳转支付 URL/二维码 → 回调验签 + 轮询双通道 → paid 只入账一次（含并发单赢家测试）；**实付金额与订单快照金额校验**；窗口尽头置 `unknown` 待对账。
- [ ] 服务端定价：客户端只传 packId/planId；金额全链路整数分。
- [ ] 凭证全走 env；金额单位分；`bun test` 全绿；测试激活码真实冒烟通过（1 分钱付款+退款）。
