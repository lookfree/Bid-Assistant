# spec304 · 支付抽象 + 支付宝单笔支付（充值 / 购买会员，架构 §6.1）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地架构 §6.1 的**单笔支付**全链路：定义可插拔的 `PaymentProvider` 接口 + 首版 `AlipayProvider`（`alipay.trade.precreate` PC 扫码 / `alipay.trade.wap.pay` H5 / 异步通知**验签** / `alipay.trade.refund` 退款），以及充值/购买会员的下单 → 回调入账路由（`POST /api/payment/recharge`、`POST /api/payment/alipay/notify`、`GET /api/payment/orders/:id`）。下单建 `payment_orders`（status=created，带幂等键）→ 用户支付 → 支付宝异步通知验签 → **订单状态机置 paid（只一次）** → 调 spec302 `credits.grant({type:"purchase"})` 按**订单快照的 `pack.credits`（含赠送）**到账（充值；无包任意金额充值才按 `credit_rate` 正向换算）或激活会员（购买套餐）。**幂等关键**：异步通知可能重复，按 `provider_trade_no` + 订单状态机保证**只入账一次**。

**Architecture:** 支付层是 `PaymentProvider` 抽象（屏蔽通道差异，§6.1），首版实现 `AlipayProvider`，后续微信支付只加一个实现、不动路由。本 spec 范围＝**单笔支付**（precreate / wapPay / verifyCallback / refund）；周期代扣的 `sign/unsign/deduct` 在接口里**先声明占位**（spec305 实现自动续费时填充），保证接口稳定不返工。钱只在 App API 动（§3.2）：路由建单、验签、改订单状态、调账本 `grant`，全部在 App 层；支付宝 SDK 纯 JS，回调**必须验签**，金额单位与 spec301 一致用 **分（`amount_cents` integer）**。订单状态机：`created → paid`（验签成功、且当前 status=created 时原子推进）/`created → failed`；重复 notify 命中已 paid 订单直接返回成功、不再 `grant`。`grant` 幂等键＝订单维度（`purchase:<orderId>`），账本侧（spec302）唯一约束 + 订单状态机双重兜底。

**Tech Stack:** Hono 4.12、Bun、Drizzle ORM、PostgreSQL（public schema）、Zod、支付宝 SDK（纯 JS，`alipay-sdk`）、bun:test。

## Global Constraints

见 `spec300-index.md`。本 spec 关键：
- **钱只在 App API 动**（§3.2）：下单、验签、改订单状态、入账全在 App 层；智能体服务不碰。
- **回调必须验签**：异步通知用支付宝公钥验签（RSA2），验签失败一律拒绝、不改任何状态。上线前支付宝**沙箱端到端冒烟**（§2.2）。
- **幂等**：异步通知可能重复 → 按 `provider_trade_no` + 订单状态机保证**只入账一次**；`grant` 用订单维度幂等键（spec302 唯一约束兜底）。
- 金额单位统一 **分**（`amount_cents` integer，对接支付宝 API 时换算成元字符串）；积分 integer。
- 充值到账积分**以命中的 `recharge_packs` 项的 `credits`（含赠送）为准**，下单时快照到订单；`credit_rate` 仅用于无包任意金额充值（正向 `credits = floor(amountCents * credits_per_cny_cent)`）。充值包从 `recharge_packs`（config）按稳定 `id` 校验，开发不写死定价。
- 支付宝密钥（APP_ID / 应用私钥 / 支付宝公钥 / 网关 / notify_url）一律从 **env** 读，**不入库、不进 git**；测试用沙箱占位值并 **mock SDK**，不打真实网络。
- TDD（`bun test`）；频繁提交；`main` 上先开分支 `phase3/spec304-alipay-single-payment`；提交信息附 `Co-Authored-By`。

---

## File Structure

```
apps/api/src/
├── services/payment/
│   ├── provider.ts          # 新：PaymentProvider 接口 + 类型（precreate/wapPay/verifyCallback/refund + 占位 sign/unsign/deduct）
│   ├── alipay.ts            # 新：AlipayProvider（封装 alipay-sdk，读 env，实现单笔四方法）
│   ├── alipay-config.ts     # 新：从 env 读支付宝配置（APP_ID/私钥/公钥/网关/notify_url）
│   └── index.ts             # 新：getPaymentProvider()（按 provider 名返回实例，默认 alipay）
├── routes/
│   └── payment.ts           # 新：POST /recharge、POST /alipay/notify、GET /orders/:id
└── services/
    └── payment-orders.ts    # 新：订单服务（建单+幂等、状态机置 paid 只一次、入账/激活会员）
apps/api/test/
├── payment-provider.test.ts # 新：AlipayProvider 单测（mock SDK：precreate 返二维码 / verifyCallback 验签通过失败 / refund）
└── payment-routes.test.ts   # 新：路由集成（下单建 order+二维码 / notify 验签→paid+grant 一次 / 重复 notify 只 grant 一次 / 验签失败拒绝）
```

> 路由在 `apps/api/src/app.ts`（Phase 0 已有 Hono app）挂载 `app.route("/api/payment", paymentRoutes)`。

---

## Interfaces

- **Consumes（上游已产出）**：
  - 表（spec301，`src/db/schema/payments.ts`）：`paymentOrders`（`id/userId/type/amountCents/status/provider/providerTradeNo/idempotencyKey/packId/credits`，其中 `packId`+`credits` 为下单时的充值包快照）、`refunds`（`id/orderId/amountCents/reason/status/operator`）。
  - 配置（spec301，`src/services/config.ts`）：`getConfig("recharge_packs") -> {id, amountCents, credits}[]`（每项稳定 `id`，`credits` 含赠送）、`getConfig("credit_rate") -> {credits_per_cny_cent}`（仅无包任意金额充值用，正向：`credits = floor(amountCents * credits_per_cny_cent)`）、`getConfig("grant_expire_days") -> number`。
  - 账本（spec302，`src/services/credits.ts`）：`grant(userId, amount, {type:"purchase", ref, idempotencyKey, expireAt?})`。
  - 邀请（spec307，`src/services/referral.ts`）：`onInviteeFirstPaid(userId)`（被邀请人首付成功触发，幂等）。
  - 鉴权（Phase 0）：`authMiddleware` + `c.get("userId")`（C 端会话）。
- **Produces（供 spec305/306/308/310 依赖）**：
  - `PaymentProvider` 接口 + `getPaymentProvider(name?)`。
  - `AlipayProvider`（spec305 复用其 SDK 客户端实现 `sign/unsign/deduct`）。
  - 订单服务 `createOrder` / `markPaid`（状态机入账，spec306 退款复用订单查询）。
  - 路由 `POST /api/payment/recharge`、`POST /api/payment/alipay/notify`、`GET /api/payment/orders/:id`（spec308 会员中心调）。

### `PaymentProvider` 形态（Task 1 落地，此处为契约）

```typescript
export interface PaymentOrderInput {
  outTradeNo: string;     // 我方订单号（= payment_orders.id）
  subject: string;        // 订单标题（如"积分充值 100"）
  amountCents: number;    // 金额（分）
}
export interface PrecreateResult { qrCode: string; }                 // PC 扫码：二维码内容
export interface WapPayResult { payUrl: string; }                   // H5：跳转链接
export interface CallbackResult {                                    // 异步通知验签结果
  verified: boolean;
  outTradeNo: string;     // 我方订单号
  tradeNo: string;        // 支付宝交易号（= provider_trade_no）
  status: "paid" | "failed" | "unknown";
  amountCents: number;    // 支付宝回传金额（分），用于校验
}
export interface RefundResult { ok: boolean; alreadyRefunded?: boolean; }  // alreadyRefunded：fundChange==="N" 重复退款，幂等已退

export interface PaymentProvider {
  readonly name: string;                                            // "alipay"
  precreate(order: PaymentOrderInput): Promise<PrecreateResult>;
  wapPay(order: PaymentOrderInput): Promise<WapPayResult>;
  verifyCallback(rawBody: Record<string, string>): Promise<CallbackResult>;
  refund(order: PaymentOrderInput, amountCents: number): Promise<RefundResult>;

  // —— 周期代扣占位（spec305 实现，本 spec 仅声明，默认抛 NotImplemented）——
  sign?(opts: SignInput): Promise<{ signUrl: string }>;
  unsign?(agreementNo: string): Promise<{ ok: boolean }>;
  deduct?(opts: DeductInput): Promise<CallbackResult>;

  // —— 对账查询占位（spec306 对账实现，本 spec 仅声明）——
  // 返回某日账单逐笔：{ tradeNo, amountCents, status } —— 与 payment_orders 比对差异
  queryBill?(billDate: string): Promise<Array<{ tradeNo: string; amountCents: number; status: "paid" | "refunded" | "closed" }>>;
}
```

---

## Task 1: `PaymentProvider` 接口 + provider 工厂

**Files:** Create `apps/api/src/services/payment/provider.ts`、`apps/api/src/services/payment/index.ts`、`apps/api/test/payment-provider.test.ts`（先建空壳）

- [ ] **Step 1: 开分支**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout -b phase3/spec304-alipay-single-payment
```

- [ ] **Step 2: 写 `services/payment/provider.ts`（接口 + 类型 + 占位错误）**

```typescript
// 支付通道抽象（§6.1）：屏蔽支付宝/微信差异。单笔支付四方法 + 周期代扣占位（spec305）。
export interface PaymentOrderInput {
  outTradeNo: string;   // 我方订单号（= payment_orders.id）
  subject: string;      // 订单标题
  amountCents: number;  // 金额（分）
}
export interface PrecreateResult { qrCode: string; }
export interface WapPayResult { payUrl: string; }
export interface CallbackResult {
  verified: boolean;
  outTradeNo: string;
  tradeNo: string;
  status: "paid" | "failed" | "unknown";
  amountCents: number;
}
export interface RefundResult { ok: boolean; alreadyRefunded?: boolean; }  // alreadyRefunded：fundChange==="N" 重复退款，幂等已退

// 周期代扣入参（spec305 用；此处先声明保证接口稳定）
export interface SignInput { externalAgreementNo: string; planName: string; period: string; deductLimitCents: number; }
export interface DeductInput { outTradeNo: string; agreementNo: string; subject: string; amountCents: number; }

export class NotImplementedError extends Error {
  constructor(method: string) { super(`${method} 未实现（spec305 周期代扣）`); this.name = "NotImplementedError"; }
}

export interface PaymentProvider {
  readonly name: string;
  precreate(order: PaymentOrderInput): Promise<PrecreateResult>;
  wapPay(order: PaymentOrderInput): Promise<WapPayResult>;
  verifyCallback(rawBody: Record<string, string>): Promise<CallbackResult>;
  refund(order: PaymentOrderInput, amountCents: number): Promise<RefundResult>;
  // 周期代扣（spec305 实现）
  sign?(opts: SignInput): Promise<{ signUrl: string }>;
  unsign?(agreementNo: string): Promise<{ ok: boolean }>;
  deduct?(opts: DeductInput): Promise<CallbackResult>;
}

// 金额换算：分 → 元字符串（支付宝 API 要求两位小数元）
export function centsToYuan(cents: number): string {
  return (cents / 100).toFixed(2);
}
// 元字符串 → 分（解析回调金额）
export function yuanToCents(yuan: string): number {
  return Math.round(parseFloat(yuan) * 100);
}
```

- [ ] **Step 3: 写 `services/payment/index.ts`（工厂）**

```typescript
import type { PaymentProvider } from "./provider";
import { AlipayProvider } from "./alipay";

let _alipay: PaymentProvider | undefined;

// 按通道名返回实例（默认 alipay）；微信支付后续只在此加分支。
export function getPaymentProvider(name: string = "alipay"): PaymentProvider {
  if (name === "alipay") {
    _alipay ??= new AlipayProvider();
    return _alipay;
  }
  throw new Error(`未知支付通道：${name}`);
}

// 测试可注入 mock provider（覆盖单例）
export function __setProviderForTest(name: string, provider: PaymentProvider): void {
  if (name === "alipay") _alipay = provider;
}
```

- [ ] **Step 4: 空壳测试 + 校验编译**

`test/payment-provider.test.ts`：先放
```typescript
import { centsToYuan, yuanToCents } from "../src/services/payment/provider";
test("金额换算 分↔元", () => {
  expect(centsToYuan(100)).toBe("1.00");
  expect(centsToYuan(1050)).toBe("10.50");
  expect(yuanToCents("10.50")).toBe(1050);
});
```

```bash
cd apps/api && bun test test/payment-provider.test.ts
```
> 此步 `alipay.ts` 尚未写，工厂 import 会失败——Task 2 补齐后整体跑通；本步可先注释掉 `index.ts` 的 import 或先实现 Task 2 的空类。推荐顺序：先建 `alipay.ts` 空类（Task 2 Step 1）再跑本测试。

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/services/payment/provider.ts apps/api/src/services/payment/index.ts apps/api/test/payment-provider.test.ts
git commit -m "feat(spec304): PaymentProvider 接口 + 通道工厂 + 金额换算(分↔元)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `AlipayProvider`（封装 alipay-sdk，env 配置 + 单笔四方法）

**Files:** Create `apps/api/src/services/payment/alipay-config.ts`、`apps/api/src/services/payment/alipay.ts`；Modify `test/payment-provider.test.ts`

- [ ] **Step 1: 装 SDK + 写 `alipay-config.ts`（从 env 读，密钥不入库）**

```bash
cd apps/api && bun add alipay-sdk
```

```typescript
// 支付宝配置全部来自 env（密钥不入库、不进 git）；沙箱网关与生产网关由 env 切换。
export interface AlipayEnvConfig {
  appId: string;
  privateKey: string;       // 应用私钥（PKCS8）
  alipayPublicKey: string;  // 支付宝公钥（验签用）
  gateway: string;          // 沙箱：https://openapi.alipaydev.com/gateway.do
  notifyUrl: string;        // 异步通知回调地址
  signType: "RSA2";
}

export function loadAlipayConfig(): AlipayEnvConfig {
  const e = process.env;
  const need = (k: string) => {
    const v = e[k];
    if (!v) throw new Error(`缺少支付宝配置 env: ${k}`);
    return v;
  };
  return {
    appId: need("ALIPAY_APP_ID"),
    privateKey: need("ALIPAY_PRIVATE_KEY"),
    alipayPublicKey: need("ALIPAY_PUBLIC_KEY"),
    gateway: e.ALIPAY_GATEWAY ?? "https://openapi.alipaydev.com/gateway.do",
    notifyUrl: need("ALIPAY_NOTIFY_URL"),
    signType: "RSA2",
  };
}
```

- [ ] **Step 2: 写 `alipay.ts`（实现 PaymentProvider 单笔四方法）**

```typescript
import { AlipaySdk } from "alipay-sdk";
import {
  type PaymentProvider, type PaymentOrderInput, type PrecreateResult,
  type WapPayResult, type CallbackResult, type RefundResult,
  type SignInput, type DeductInput, NotImplementedError, centsToYuan, yuanToCents,
} from "./provider";
import { loadAlipayConfig, type AlipayEnvConfig } from "./alipay-config";

export class AlipayProvider implements PaymentProvider {
  readonly name = "alipay";
  private sdk: AlipaySdk;
  private cfg: AlipayEnvConfig;

  // 允许注入 sdk（测试 mock）；默认从 env 构造。
  constructor(sdk?: AlipaySdk, cfg?: AlipayEnvConfig) {
    this.cfg = cfg ?? loadAlipayConfig();
    this.sdk = sdk ?? new AlipaySdk({
      appId: this.cfg.appId,
      privateKey: this.cfg.privateKey,
      alipayPublicKey: this.cfg.alipayPublicKey,
      gateway: this.cfg.gateway,
      signType: this.cfg.signType,
    });
  }

  // PC 扫码：alipay.trade.precreate → 返回二维码内容
  async precreate(order: PaymentOrderInput): Promise<PrecreateResult> {
    const res = await this.sdk.exec("alipay.trade.precreate", {
      notifyUrl: this.cfg.notifyUrl,
      bizContent: { out_trade_no: order.outTradeNo, subject: order.subject, total_amount: centsToYuan(order.amountCents) },
    });
    if (res.code !== "10000" || !res.qrCode) throw new Error(`precreate 失败: ${res.code} ${res.msg ?? ""}`);
    return { qrCode: res.qrCode as string };
  }

  // H5：alipay.trade.wap.pay → 返回带签名的跳转链接（pageExec 返回 URL）
  async wapPay(order: PaymentOrderInput): Promise<WapPayResult> {
    const payUrl = this.sdk.pageExec("alipay.trade.wap.pay", {
      method: "GET",
      notifyUrl: this.cfg.notifyUrl,
      bizContent: {
        out_trade_no: order.outTradeNo, subject: order.subject,
        total_amount: centsToYuan(order.amountCents), product_code: "QUICK_WAP_WAY",
      },
    });
    return { payUrl };
  }

  // 异步通知验签：用支付宝公钥校验签名（RSA2）。验签失败 verified=false。
  async verifyCallback(rawBody: Record<string, string>): Promise<CallbackResult> {
    let verified = false;
    try {
      verified = this.sdk.checkNotifySign(rawBody);
    } catch {
      verified = false;
    }
    const tradeStatus = rawBody.trade_status;
    const status: CallbackResult["status"] =
      tradeStatus === "TRADE_SUCCESS" || tradeStatus === "TRADE_FINISHED" ? "paid"
      : tradeStatus === "TRADE_CLOSED" ? "failed" : "unknown";
    return {
      verified,
      outTradeNo: rawBody.out_trade_no ?? "",
      tradeNo: rawBody.trade_no ?? "",
      status,
      amountCents: rawBody.total_amount ? yuanToCents(rawBody.total_amount) : 0,
    };
  }

  // 退款：alipay.trade.refund（spec306 退款流程调用）
  async refund(order: PaymentOrderInput, amountCents: number): Promise<RefundResult> {
    const res = await this.sdk.exec("alipay.trade.refund", {
      bizContent: { out_trade_no: order.outTradeNo, refund_amount: centsToYuan(amountCents) },
    });
    // ok 仅看接口受理成功；fundChange==="N" 表示本次无资金变动（重复退款），单独标记为「幂等已退」。
    const ok = res.code === "10000";
    const alreadyRefunded = ok && res.fundChange === "N";
    return { ok, alreadyRefunded };
  }

  // —— 周期代扣占位（spec305 实现）——
  async sign(_opts: SignInput): Promise<{ signUrl: string }> { throw new NotImplementedError("sign"); }
  async unsign(_agreementNo: string): Promise<{ ok: boolean }> { throw new NotImplementedError("unsign"); }
  async deduct(_opts: DeductInput): Promise<CallbackResult> { throw new NotImplementedError("deduct"); }
}
```

> 说明：`alipay-sdk` 的 `exec` 返回字段名为驼峰（`qrCode`/`tradeNo`/`fundChange`）；异步通知原始字段为下划线（`out_trade_no`/`trade_no`/`trade_status`/`total_amount`），故 `verifyCallback` 直接读下划线键。`checkNotifySign(rawBody)` 对**完整通知参数表**（含 `sign`/`sign_type`）验签。

- [ ] **Step 3: 失败测试 `test/payment-provider.test.ts`（mock SDK）**

```typescript
import { AlipayProvider } from "../src/services/payment/alipay";
import type { AlipayEnvConfig } from "../src/services/payment/alipay-config";

const fakeCfg: AlipayEnvConfig = {
  appId: "sandbox_app", privateKey: "pk", alipayPublicKey: "pub",
  gateway: "https://openapi.alipaydev.com/gateway.do", notifyUrl: "https://x/notify", signType: "RSA2",
};
function makeProvider(sdkOverrides: Partial<any>): AlipayProvider {
  const sdk: any = {
    exec: async () => ({ code: "10000" }),
    pageExec: () => "https://pay.url",
    checkNotifySign: () => true,
    ...sdkOverrides,
  };
  return new AlipayProvider(sdk, fakeCfg);
}

test("precreate 返回二维码内容", async () => {
  const p = makeProvider({ exec: async () => ({ code: "10000", qrCode: "https://qr.alipay/abc" }) });
  const r = await p.precreate({ outTradeNo: "o1", subject: "充值100", amountCents: 100 });
  expect(r.qrCode).toBe("https://qr.alipay/abc");
});

test("precreate 失败抛错", async () => {
  const p = makeProvider({ exec: async () => ({ code: "40004", msg: "BIZ" }) });
  await expect(p.precreate({ outTradeNo: "o1", subject: "x", amountCents: 100 })).rejects.toThrow();
});

test("wapPay 返回跳转链接", async () => {
  const p = makeProvider({ pageExec: () => "https://openapi.alipaydev.com/gateway.do?biz=..." });
  const r = await p.wapPay({ outTradeNo: "o1", subject: "x", amountCents: 100 });
  expect(r.payUrl).toContain("alipaydev.com");
});

test("verifyCallback 验签通过 → paid + 解析字段", async () => {
  const p = makeProvider({ checkNotifySign: () => true });
  const r = await p.verifyCallback({
    out_trade_no: "o1", trade_no: "T1", trade_status: "TRADE_SUCCESS", total_amount: "1.00", sign: "s", sign_type: "RSA2",
  });
  expect(r.verified).toBe(true);
  expect(r.status).toBe("paid");
  expect(r.outTradeNo).toBe("o1");
  expect(r.tradeNo).toBe("T1");
  expect(r.amountCents).toBe(100);
});

test("verifyCallback 验签失败 → verified=false", async () => {
  const p = makeProvider({ checkNotifySign: () => false });
  const r = await p.verifyCallback({ out_trade_no: "o1", trade_no: "T1", trade_status: "TRADE_SUCCESS", total_amount: "1.00" });
  expect(r.verified).toBe(false);
});

test("sign/unsign/deduct 未实现抛 NotImplementedError", async () => {
  const p = makeProvider({});
  await expect(p.sign!({ externalAgreementNo: "a", planName: "p", period: "MONTH", deductLimitCents: 100 })).rejects.toThrow();
});
```

- [ ] **Step 4: 通过 + 提交**

```bash
cd apps/api && bun test test/payment-provider.test.ts
git add apps/api/src/services/payment/alipay.ts apps/api/src/services/payment/alipay-config.ts apps/api/test/payment-provider.test.ts apps/api/package.json
git commit -m "feat(spec304): AlipayProvider(precreate/wapPay/verifyCallback验签/refund + 代扣占位)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 订单服务（建单 + 幂等 + 状态机置 paid 入账）

**Files:** Create `apps/api/src/services/payment-orders.ts`、`apps/api/test/payment-routes.test.ts`（先放订单服务单测）

- [ ] **Step 1: 写 `services/payment-orders.ts`（建单 + markPaid 状态机）**

```typescript
import { db } from "../db";
import { paymentOrders } from "../db/schema/payments";
import { eq, and } from "drizzle-orm";
import { getConfig } from "./config";
import { grant } from "./credits";
import { onInviteeFirstPaid } from "./referral";   // spec307 导出：邀请延迟解锁触发点

// recharge_packs 每项有稳定 id（不依赖数组下标）；credits 含赠送，到账以此为准。
export interface RechargePack { id: number; amountCents: number; credits: number; }

/** 校验充值包：按稳定 id 在 config 的 recharge_packs 中查找（杜绝后台重排导致下标漂移）。 */
export async function resolveRechargePack(packId: number): Promise<RechargePack> {
  const packs = (await getConfig<RechargePack[]>("recharge_packs")) ?? [];
  const pack = packs.find((p) => p.id === packId);
  if (!pack) throw new Error(`无效充值包: ${packId}`);
  return pack;
}

/** 建单：status=created，幂等键防同一意图重复建单。命中包时把 packId + credits 快照到订单（到账以快照为准）。返回订单。 */
export async function createOrder(input: {
  userId: string; type: "recharge" | "purchase" | "auto_renew";
  amountCents: number; idempotencyKey: string;
  packId?: number;    // 命中的充值包 id（无包任意金额充值时为空）
  credits?: number;   // 充值到账积分快照（含赠送；无包任意金额充值时按 credit_rate 现算，见 markPaid）
}): Promise<typeof paymentOrders.$inferSelect> {
  // 幂等：同 key 已存在 → 返回原单（避免重复下单）
  const [exist] = await db.select().from(paymentOrders)
    .where(eq(paymentOrders.idempotencyKey, input.idempotencyKey));
  if (exist) return exist;
  const [row] = await db.insert(paymentOrders).values({
    userId: input.userId, type: input.type, amountCents: input.amountCents,
    status: "created", provider: "alipay", idempotencyKey: input.idempotencyKey,
    packId: input.packId ?? null, credits: input.credits ?? null,
  }).returning();
  return row;
}

export async function getOrder(id: string): Promise<typeof paymentOrders.$inferSelect | undefined> {
  const [row] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, id));
  return row;
}

/**
 * 状态机置 paid + 入账，保证「只一次」：
 *  - 仅当 status=created 时原子 UPDATE→paid（带 provider_trade_no）；UPDATE 影响 0 行 = 已处理过/不存在 → 跳过入账。
 *  - 入账后即便重复通知，因 status 已非 created，UPDATE 0 行 → 不再 grant（订单状态机幂等）。
 *  - grant 自身再带订单维度幂等键（spec302 唯一约束双兜底）。
 */
export async function markPaid(orderId: string, providerTradeNo: string): Promise<{ creditedNow: boolean }> {
  const updated = await db.update(paymentOrders)
    .set({ status: "paid", providerTradeNo })
    .where(and(eq(paymentOrders.id, orderId), eq(paymentOrders.status, "created")))
    .returning();
  if (updated.length === 0) return { creditedNow: false };   // 已 paid / 不存在 → 不重复入账

  const order = updated[0];
  if (order.type === "recharge") {
    // 充值入账：优先用下单时快照的 pack.credits（含赠送）；无包任意金额充值才按 credit_rate 正向换算。
    let credits = order.credits;
    if (credits == null) {
      // 无包任意金额充值：credits = floor(amountCents * credits_per_cny_cent)（正向，不要除）
      const rate = (await getConfig<{ credits_per_cny_cent: number }>("credit_rate"))?.credits_per_cny_cent ?? 1;
      credits = Math.floor(order.amountCents * rate);
    }
    const expireDays = (await getConfig<number>("grant_expire_days")) ?? 30;
    const expireAt = new Date(Date.now() + expireDays * 86400_000);
    await grant(order.userId, credits, {
      type: "purchase", ref: `order:${order.id}`, idempotencyKey: `purchase:${order.id}`, expireAt,
    });
  }
  // type=purchase（购买会员）：此处激活会员 —— 见 Step 注；Phase 3 本 spec 充值为主，会员激活留接口

  // 邀请延迟解锁触发点之一：被邀请人首次充值/购买成功 → 解锁邀请人奖励（spec307）。
  // 幂等、失败不阻断入账主链路。
  await onInviteeFirstPaid(order.userId).catch(() => {});

  return { creditedNow: true };
}
```

> 充值入账金额来源：**下单时把命中包的 `pack.credits`（含赠送）快照进订单**（`payment_orders.credits`，配套 `payment_orders.pack_id`），`markPaid` 直接 `grant(order.credits)`，**不再用 `amountCents/rate` 重算**（否则赠送积分丢失，如 1000 分包应到 1100 却只到 1000）。仅当订单无快照（无包任意金额充值）时才用 `credit_rate` 正向换算 `floor(amountCents * credits_per_cny_cent)`。若 spec301 的 `payment_orders` 尚无 `pack_id`/`credits` 列，则在本 spec 加迁移补两列（或随幂等 ref/JSON 透传快照）。
>
> 会员激活（`type:"purchase"`）：调 subscriptions 写 active + period（spec308 会员中心衔接）；本 spec 以**充值积分到账**为主链路并测试，会员激活分支留 TODO + 单测覆盖"recharge 入账一次"。激活逻辑在 spec308 接入会员中心时补全（写 `subscriptions`）。

- [ ] **Step 2: 失败测试（订单服务，写在 `test/payment-routes.test.ts` 顶部）**

```typescript
import { createOrder, markPaid, getOrder, resolveRechargePack } from "../src/services/payment-orders";
import { getBalance } from "../src/services/credits";
import { seedConfigs } from "../src/services/config";

test("createOrder 幂等：同 key 不重复建单", async () => {
  const userId = await makeTestUser();
  const a = await createOrder({ userId, type: "recharge", amountCents: 100, idempotencyKey: "rc:k1" });
  const b = await createOrder({ userId, type: "recharge", amountCents: 100, idempotencyKey: "rc:k1" });
  expect(a.id).toBe(b.id);
  expect(a.status).toBe("created");
});

test("markPaid：created→paid 按包 credits 快照入账(含赠送)一次；重复 markPaid 不再 grant", async () => {
  const userId = await makeTestUser();
  await seedConfigs();   // recharge_packs 含 id=1 的 {amountCents:1000, credits:1100}（100 为赠送）
  const pack = await resolveRechargePack(1);
  const order = await createOrder({
    userId, type: "recharge", amountCents: pack.amountCents, idempotencyKey: "rc:k2",
    packId: pack.id, credits: pack.credits,
  });
  const r1 = await markPaid(order.id, "TRADE_001");
  expect(r1.creditedNow).toBe(true);
  expect((await getOrder(order.id))!.status).toBe("paid");
  expect(await getBalance(userId)).toBe(1100);               // 1000 分包到账 1100（含 100 赠送），不是 1000
  const r2 = await markPaid(order.id, "TRADE_001");         // 重复通知
  expect(r2.creditedNow).toBe(false);
  expect(await getBalance(userId)).toBe(1100);              // 仍只入账一次
});

test("markPaid：无包任意金额充值按 credit_rate 正向换算入账", async () => {
  const userId = await makeTestUser();
  await seedConfigs();   // credit_rate.credits_per_cny_cent=1（1 积分/分）
  const order = await createOrder({ userId, type: "recharge", amountCents: 100, idempotencyKey: "rc:k2b" });
  await markPaid(order.id, "TRADE_001b");
  expect(await getBalance(userId)).toBe(100);                // floor(100 * 1) = 100
});

test("resolveRechargePack 按稳定 id 查找；无效 id 抛错", async () => {
  await seedConfigs();
  expect((await resolveRechargePack(1)).id).toBe(1);
  await expect(resolveRechargePack(999)).rejects.toThrow();
});
```

- [ ] **Step 3: 通过 + 提交**

```bash
cd apps/api && bun test test/payment-routes.test.ts
git add apps/api/src/services/payment-orders.ts apps/api/test/payment-routes.test.ts
git commit -m "feat(spec304): 订单服务(建单幂等 + markPaid 状态机置paid只入账一次)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 路由（recharge 下单 / alipay notify 回调 / 查订单）

**Files:** Create `apps/api/src/routes/payment.ts`；Modify `apps/api/src/app.ts`（挂载）、`test/payment-routes.test.ts`

- [ ] **Step 1: 写 `routes/payment.ts`**

```typescript
import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";   // Phase 0：写 c.set("userId", ...)
import { getPaymentProvider } from "../services/payment";
import { createOrder, getOrder, markPaid, resolveRechargePack } from "../services/payment-orders";

export const paymentRoutes = new Hono();

const rechargeSchema = z.object({ packId: z.number().int().nonnegative() });

// 充值下单：校验充值包 → 建单(created+幂等键) → provider.precreate → 返二维码 + 订单号
paymentRoutes.post("/recharge", authMiddleware, async (c) => {
  const userId = c.get("userId") as string;
  const body = rechargeSchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: "参数错误" }, 400);

  const pack = await resolveRechargePack(body.data.packId);  // 按稳定 id 查找；无效包 → 抛错 → 500（或下方 try 捕获 400）
  const idempotencyKey = `recharge:${userId}:${pack.id}:${Date.now()}`;
  // 把命中包的 id + credits（含赠送）快照进订单，markPaid 直接按快照入账（不再重算）。
  const order = await createOrder({
    userId, type: "recharge", amountCents: pack.amountCents, idempotencyKey,
    packId: pack.id, credits: pack.credits,
  });

  const provider = getPaymentProvider("alipay");
  const { qrCode } = await provider.precreate({
    outTradeNo: order.id, subject: `积分充值 ${pack.credits}`, amountCents: pack.amountCents,
  });
  return c.json({ orderId: order.id, qrCode, amountCents: pack.amountCents });
});

// 支付宝异步通知：验签 → 校验金额 → markPaid 状态机入账。验签失败拒绝。
// 支付宝要求：处理成功必须返回纯文本 "success"，否则会重试（重试由 markPaid 幂等兜底）。
paymentRoutes.post("/alipay/notify", async (c) => {
  // 支付宝以 application/x-www-form-urlencoded POST 全部参数（含 sign）
  const form = await c.req.parseBody();
  const rawBody = Object.fromEntries(
    Object.entries(form).map(([k, v]) => [k, String(v)]),
  ) as Record<string, string>;

  const provider = getPaymentProvider("alipay");
  const result = await provider.verifyCallback(rawBody);
  if (!result.verified) return c.text("failure", 400);       // 验签失败 → 拒绝、不改状态

  if (result.status === "paid") {
    const order = await getOrder(result.outTradeNo);
    // 金额一致性校验（防篡改）：回传金额必须等于订单金额
    if (!order || order.amountCents !== result.amountCents) return c.text("failure", 400);
    await markPaid(result.outTradeNo, result.tradeNo);       // 幂等：重复通知只入账一次
  }
  return c.text("success");                                  // 支付宝据此停止重试
});

// 查订单状态（前端轮询）
paymentRoutes.get("/orders/:id", authMiddleware, async (c) => {
  const userId = c.get("userId") as string;
  const order = await getOrder(c.req.param("id"));
  if (!order || order.userId !== userId) return c.json({ error: "未找到订单" }, 404);
  return c.json({ id: order.id, status: order.status, amountCents: order.amountCents, type: order.type });
});
```

- [ ] **Step 2: 在 `app.ts` 挂载**

```typescript
import { paymentRoutes } from "./routes/payment";
// ...
app.route("/api/payment", paymentRoutes);
```

- [ ] **Step 3: 失败测试（路由集成，mock provider 注入）**

```typescript
import { app } from "../src/app";
import { __setProviderForTest } from "../src/services/payment";
import type { PaymentProvider } from "../src/services/payment/provider";

// 注入 mock provider（不打真实支付宝网络）
function installMockProvider(over: Partial<PaymentProvider> = {}) {
  const mock: PaymentProvider = {
    name: "alipay",
    precreate: async (o) => ({ qrCode: `qr://${o.outTradeNo}` }),
    wapPay: async () => ({ payUrl: "https://pay" }),
    verifyCallback: async (raw) => ({
      verified: raw.sign !== "BAD",
      outTradeNo: raw.out_trade_no, tradeNo: raw.trade_no,
      status: raw.trade_status === "TRADE_SUCCESS" ? "paid" : "unknown",
      amountCents: Math.round(parseFloat(raw.total_amount ?? "0") * 100),
    }),
    refund: async () => ({ ok: true }),
    ...over,
  };
  __setProviderForTest("alipay", mock);
}

test("POST /recharge 建单 + 返二维码", async () => {
  await seedConfigs();
  installMockProvider();
  const { token, userId } = await makeAuthedUser();   // 夹具：返回带会话 token + userId
  const res = await app.request("/api/payment/recharge", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ packId: 1 }),              // recharge_packs 中 id=1 → {amountCents:1000, credits:1100}
  });
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.orderId).toBeTruthy();
  expect(json.qrCode).toContain("qr://");
  expect(json.amountCents).toBe(1000);
});

test("notify 验签通过 → 订单 paid + grant 一次", async () => {
  await seedConfigs();
  installMockProvider();
  const { token, userId } = await makeAuthedUser();
  const created = await (await app.request("/api/payment/recharge", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ packId: 1 }),
  })).json();

  const notifyBody = new URLSearchParams({
    out_trade_no: created.orderId, trade_no: "T100", trade_status: "TRADE_SUCCESS",
    total_amount: "10.00", sign: "GOOD", sign_type: "RSA2",
  });
  const r1 = await app.request("/api/payment/alipay/notify", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: notifyBody.toString(),
  });
  expect(await r1.text()).toBe("success");

  const ord = await (await app.request(`/api/payment/orders/${created.orderId}`, {
    headers: { authorization: `Bearer ${token}` },
  })).json();
  expect(ord.status).toBe("paid");
  expect(await getBalance(userId)).toBe(1100);   // 按包 credits 快照入账(含赠送)
});

test("重复 notify 只 grant 一次（幂等）", async () => {
  await seedConfigs();
  installMockProvider();
  const { token, userId } = await makeAuthedUser();
  const created = await (await app.request("/api/payment/recharge", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ packId: 1 }),
  })).json();
  const body = new URLSearchParams({
    out_trade_no: created.orderId, trade_no: "T101", trade_status: "TRADE_SUCCESS",
    total_amount: "10.00", sign: "GOOD", sign_type: "RSA2",
  }).toString();
  const hdr = { "content-type": "application/x-www-form-urlencoded" };
  await app.request("/api/payment/alipay/notify", { method: "POST", headers: hdr, body });
  await app.request("/api/payment/alipay/notify", { method: "POST", headers: hdr, body });  // 重复
  expect(await getBalance(userId)).toBe(1100);   // 仍只入账一次
});

test("验签失败 → 拒绝、订单仍 created、不入账", async () => {
  await seedConfigs();
  installMockProvider();
  const { token, userId } = await makeAuthedUser();
  const created = await (await app.request("/api/payment/recharge", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ packId: 1 }),
  })).json();
  const body = new URLSearchParams({
    out_trade_no: created.orderId, trade_no: "T102", trade_status: "TRADE_SUCCESS",
    total_amount: "10.00", sign: "BAD", sign_type: "RSA2",
  }).toString();
  const res = await app.request("/api/payment/alipay/notify", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
  });
  expect(res.status).toBe(400);
  const ord = await (await app.request(`/api/payment/orders/${created.orderId}`, {
    headers: { authorization: `Bearer ${token}` },
  })).json();
  expect(ord.status).toBe("created");
  expect(await getBalance(userId)).toBe(0);
});
```

> 测试夹具：`makeTestUser()`（spec301/302 已有）、`makeAuthedUser()`（建用户 + 发一个有效会话 token，复用 Phase 0 会话工具）。若 Phase 0 无现成 token 工具，可在 `authMiddleware` 测试侧用 header 直接注入 userId 的测试桩。

- [ ] **Step 4: 通过 + 提交**

```bash
cd apps/api && bun test test/payment-routes.test.ts
git add apps/api/src/routes/payment.ts apps/api/src/app.ts apps/api/test/payment-routes.test.ts
git commit -m "feat(spec304): 路由 recharge下单/alipay notify回调(验签+金额校验+幂等入账)/查订单

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 全量回归 + 合并

**Files:** —（仅验证 + 合并）

- [ ] **Step 1: 全量测试 + env 文档**

```bash
cd apps/api && bun test
```
在 `.env.example` 补支付宝 env 键（不含真实值）：`ALIPAY_APP_ID` / `ALIPAY_PRIVATE_KEY` / `ALIPAY_PUBLIC_KEY` / `ALIPAY_GATEWAY` / `ALIPAY_NOTIFY_URL`。

- [ ] **Step 2: 合并**

```bash
cd apps/api && bun test
git add apps/api/.env.example
git commit -m "chore(spec304): .env.example 补支付宝沙箱配置键(无真实值)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout main && git merge --no-ff phase3/spec304-alipay-single-payment -m "merge spec304: 支付抽象 + 支付宝单笔支付"
git push origin main
```

---

## 验收清单（spec304）

- [ ] `PaymentProvider` 接口落地：`precreate/wapPay/verifyCallback/refund` + 周期代扣占位 `sign/unsign/deduct`（默认抛 `NotImplementedError`，spec305 填充）。
- [ ] `AlipayProvider` 用 `alipay-sdk` 实现：`alipay.trade.precreate`（PC 扫码返二维码）/`alipay.trade.wap.pay`（H5 跳转）/异步通知 `checkNotifySign` **验签**/`alipay.trade.refund`；配置全部从 env，密钥不入库不进 git。
- [ ] `getPaymentProvider()` 工厂可插拔（默认 alipay，微信后续只加分支）；测试可注入 mock provider。
- [ ] `POST /api/payment/recharge`：校验充值包（`recharge_packs` config）→ 建 `payment_orders`（created + 幂等键）→ `precreate` → 返二维码 + 订单号。
- [ ] `POST /api/payment/alipay/notify`：验签通过 + **金额一致性校验** → `markPaid` 状态机 `created→paid`（只一次）→ 充值按**订单快照的 `pack.credits`（含赠送）** `grant({type:"purchase"})` 到账（无包任意金额充值才按 `credit_rate` 正向换算）；触发 `onInviteeFirstPaid`；返回 `"success"`。
- [ ] **幂等**：重复 notify 只入账一次（订单状态机 `WHERE status=created` 原子 UPDATE + grant 订单维度幂等键双兜底）；按 `provider_trade_no` 落库。
- [ ] **验签失败拒绝**：不改任何状态、不入账、返回 4xx。
- [ ] `GET /api/payment/orders/:id`：鉴权 + 归属校验，返订单状态（供前端轮询 / spec308）。
- [ ] 金额统一**分**（对接支付宝换算元字符串）；钱只在 App 层动。
- [ ] `bun test` 全绿；测试全程 **mock SDK**、不打真实网络；`.env.example` 含支付宝键。
```