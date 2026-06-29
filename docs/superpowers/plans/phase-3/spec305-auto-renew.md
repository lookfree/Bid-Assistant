# spec305 · 自动续费（支付宝周期代扣）★ 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现**自动续费（支付宝周期代扣）**全链路（架构 §6.2）：**签约**（`agreement.page.sign` 生成签约页 + 回调落 `payment_agreements` + `subscriptions.auto_renew=true`）→ **代扣 Cron**（spec303 `registerCron` 扫 `next_deduct_at<=now AND auto_renew=true`，建幂等订单 → `provider.deduct` → 成功续期 + 发当期赠送积分 + 推进周期 / 失败进重试状态机）→ **解约**（`agreement.unsign` + `auto_renew=false`，当周期保留至到期、到期降级免费版）→ **重试状态机 + past_due 降级兜底**（按 `deduct_retry` 的 `intervalsDays=[1,3]`/`maxAttempts` 重试，超限 `past_due` + 推送提醒 + 降级为手动续费，不无限重试避风控）。

**Architecture:** 钱只在 App API 动（§3.2）。签约/解约/代扣调 spec304 `PaymentProvider` 的 `sign/unsign/deduct`（spec304 已声明为占位 `NotImplementedError`，**本 spec 在 `AlipayProvider` 上填充实现**），对应支付宝 `user.agreement.page.sign`/`unsign`/`trade.pay`（代扣场景）。代扣由 spec303 **Redis 单例 Cron**（`registerCron`/`startCronRunner` + `withCronLock`）驱动，job 体**以 DB 为准**扫到期项、逐条幂等，业务**幂等键=`subscriptionId+账单周期`** 兜底，双触发不重复扣。续期成功调 spec302 `credits.grant` 发当期 `grant_credits_per_cycle` 赠送积分。状态机：`payment_agreements.status: signing→signed→unsigned`（含 `sign_failed`）、`subscriptions.status: active→past_due→expired`、`auto_renew` 独立布尔。**降级兜底**：周期扣款产品未过审/不可用时，首版回退「到期提醒 + 用户手动扫码续费」（走 spec304 单笔），通过 `AUTO_RENEW_ENABLED` 开关切换，保证收入不断档。

> **上游契约对齐（spec303/spec304 已落地，签名以下为准）**
> - 取 provider：`getPaymentProvider("alipay")`（spec304 工厂）；测试用 `__setProviderForTest("alipay", mock)` 注入 mock，**不打真实网络**。
> - spec304 `PaymentProvider` 代扣三方法签名（本 spec 填充 `AlipayProvider`）：
>   - `sign(opts: SignInput) -> Promise<{ signUrl: string }>`，`SignInput = { externalAgreementNo; planName; period; deductLimitCents }`。
>   - `unsign(agreementNo: string) -> Promise<{ ok: boolean }>`。
>   - `deduct(opts: DeductInput) -> Promise<CallbackResult>`，`DeductInput = { outTradeNo; agreementNo; subject; amountCents }`，`CallbackResult = { verified; outTradeNo; tradeNo; status:"paid"|"failed"|"unknown"; amountCents }`。
> - 我方签约号 `agreementNo` 由**本 spec 生成**（`payment_agreements.id` 或 `randomUUID`），传给 `sign` 作 `externalAgreementNo`；签约页 URL 即 `sign` 返回的 `signUrl`。
> - 复用 spec304 订单服务 `createOrder({ userId, type:"auto_renew", amountCents, idempotencyKey })`（已内建幂等：同 key 返回原单）。
> - cron 注册走 spec303：在 worker 入口 `startCronRunner([{ name, everyMs, jobFn }])`，`jobFn` 即本 spec 的 `autoRenewJob`（`runDeductCycle` 的无参包装）。

**Tech Stack:** Hono、Drizzle ORM、PostgreSQL（事务）、Redis（Cron 锁，库 3 前缀 `bid:`）、Zod、bun:test。

## Global Constraints

见 `spec300-index.md`。本 spec 关键：
- **钱只在 App API 动**；签约/解约/代扣全部经 spec304 `PaymentProvider` 抽象，回调**必须验签**（验签复用 spec304）。
- **所有扣减/回调带幂等键**：代扣订单幂等键 = `auto_renew:<subscriptionId>:<billingPeriod>`（同周期不重复扣）；`payment_orders.idempotency_key` 唯一约束（spec301）兜底。
- 周期任务统一走 **spec303 Redis 单例 Cron**（`registerCron`/`withCronLock`），不引入独立调度器；锁内执行，双触发由业务幂等键兜底。
- **重试有上限**（`deduct_retry.maxAttempts`），不无限重试（避免触发支付宝风控）。
- **降级兜底必须实现**：`AUTO_RENEW_ENABLED=false`（或周期产品未过审）时回退到「到期提醒 + 手动扫码续费」（spec304 单笔）。
- 金额单位 `*_cents`（integer 分）；TDD（bun test）；`main` 上先开分支 `phase3/spec305-auto-renew`。

---

## File Structure

```
apps/api/src/
├── services/
│   ├── auto-renew.ts            # 新：签约/解约/代扣业务（signAgreement/handleSignCallback/unsignAgreement/deductOne/applyDeductFailure/runDeductCycle/runRenewReminder/autoRenewJob）
│   ├── auto-renew-period.ts     # 新：账单周期推进（advancePeriod）+ 周期标识（billingPeriodKey）
│   ├── auto-renew-retry.ts      # 新：重试状态机纯函数（nextDeductRetry）
│   ├── notify.ts                # 新：推送提醒（past_due/到期提醒；首版写库 + console，留接口）
│   └── payment/alipay.ts        # 改：填充 sign/unsign/deduct（spec304 已留占位 NotImplementedError）
├── routes/
│   └── auto-renew.ts            # 新：POST /sign、/sign/callback、POST /unsign
├── cron/
│   └── auto-renew-cron.ts       # 新：autoRenewJob 注册定义（供 startCronRunner）
└── config/auto-renew.ts         # 新：AUTO_RENEW_ENABLED 开关 + 读 deduct_retry/plan 配置
apps/api/test/
├── auto-renew-provider.test.ts  # 新：AlipayProvider sign/unsign/deduct(mock SDK)
├── auto-renew-sign.test.ts      # 新：签约页 + 回调落库 + auto_renew=true
├── auto-renew-unsign.test.ts    # 新：解约 → auto_renew=false + 当周期保留
├── auto-renew-deduct.test.ts    # 新：代扣成功续期+发积分+推进 + 幂等不重复扣
├── auto-renew-retry.test.ts     # 新：失败重试计数 + 超 maxAttempts → past_due
└── auto-renew-fallback.test.ts  # 新：AUTO_RENEW_ENABLED=false 降级到期提醒
```

---

## Interfaces

- **Consumes（上游契约）**：
  - spec301 表：`subscriptions`（`autoRenew`/`agreementNo`/`currentPeriodStart`/`currentPeriodEnd`/`status`/`planId`）、`paymentAgreements`（`status`/`externalAgreementNo`/`nextDeductAt`/`deductLimitCents`/`planId`/`period`）、`paymentOrders`（`type`/`amountCents`/`status`/`idempotencyKey`/`providerTradeNo`）、`plans`（`priceCents`/`grantCreditsPerCycle`/`billingCycle`）。
  - spec302 `credits.grant(userId, amount, { type:"grant", expireAt, ref, idempotencyKey })`（发当期赠送积分）。
  - spec303 `registerCron(name, everyMs, jobFn, opts?)` / `withCronLock(name, fn, opts?)` / `startCronRunner(jobs)`（代扣定时任务用；job 体以 DB 为准、逐条幂等）。
  - spec304 `getPaymentProvider("alipay")` + `__setProviderForTest`（测试注入）；`PaymentProvider` 代扣三方法 `sign(opts)→{signUrl}`、`unsign(agreementNo)→{ok}`、`deduct(opts)→CallbackResult`（本 spec 填充 `AlipayProvider`，spec304 已声明占位）。
  - spec304 订单服务 `createOrder({ userId, type:"auto_renew", amountCents, idempotencyKey })`（建单幂等）、`getOrder(id)`。
  - config（spec301 `getConfig`）：`deduct_retry`（`{ intervalsDays:[1,3], maxAttempts:3 }`）、`plans.grant_credits_per_cycle`（plan 表字段）、`grant_expire_days`（赠送积分有效期）。
- **Produces（供 spec308 会员中心 / spec306 对账依赖）**：
  - `signAgreement(provider, userId, planId) -> Promise<{ signPageUrl, agreementNo }>`。
  - `handleSignCallback(payload) -> Promise<void>`（agreement=signed + auto_renew=true + 关联 agreement_no）。
  - `unsignAgreement(provider, userId) -> Promise<void>`（unsign → agreement=unsigned + auto_renew=false，当周期保留）。
  - `deductOne(provider, sub, now)` / `applyDeductFailure(sub, now)` / `runDeductCycle(provider, now) -> Promise<{ scanned, deducted, retried, pastDue }>`（cron job 体，可直接调）。
  - `autoRenewJob`（`runDeductCycle` 的无参包装，供 `startCronRunner` 注册）/ `runRenewReminder(now, leadDays)`（降级提醒）。
  - 纯函数：`billingPeriodKey(subscriptionId, periodStart)`、`advancePeriod(cycle, from)`、`nextDeductRetry(attempts, now, retry)`。
  - `AlipayProvider` 填充后的 `sign/unsign/deduct`（spec308 会员中心间接复用）。

---

## Task 1: 周期推进 + 幂等键 + 重试纯函数（无 I/O，先固定算法）

**Files:** Create `apps/api/src/services/auto-renew-period.ts`、`services/auto-renew-retry.ts`、`apps/api/test/auto-renew-period.test.ts`

- [ ] **Step 1: 开分支**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout -b phase3/spec305-auto-renew
```

- [ ] **Step 2: 写 `services/auto-renew-period.ts`（周期推进 + 幂等键，纯函数）**

```typescript
// 账单周期标识：subscriptionId + 周期起点(YYYY-MM-DD) → 幂等键基底（同周期同键）
export function billingPeriodKey(subscriptionId: string, periodStart: Date): string {
  const d = periodStart.toISOString().slice(0, 10);            // YYYY-MM-DD
  return `auto_renew:${subscriptionId}:${d}`;
}

// 按计费周期推进（month/quarter/year）；返回新的周期结束/下次扣款时间
export function advancePeriod(cycle: string, from: Date): Date {
  const d = new Date(from);
  if (cycle === "month") d.setMonth(d.getMonth() + 1);
  else if (cycle === "quarter") d.setMonth(d.getMonth() + 3);
  else if (cycle === "year") d.setFullYear(d.getFullYear() + 1);
  else throw new Error(`未知计费周期: ${cycle}`);
  return d;
}
```

- [ ] **Step 3: 写 `services/auto-renew-retry.ts`（重试状态机，纯函数）**

```typescript
export type DeductRetryConfig = { intervalsDays: number[]; maxAttempts: number };

// 输入已尝试次数 attempts（含本次失败），返回下次重试时间或 null（超上限）。
// intervalsDays=[1,3]：第 1 次失败 → T+1，第 2 次失败 → T+3，第 3 次失败(达 maxAttempts) → null。
export function nextDeductRetry(attempts: number, now: Date, retry: DeductRetryConfig): Date | null {
  if (attempts >= retry.maxAttempts) return null;             // 超上限 → 不再重试
  const idx = Math.min(attempts - 1, retry.intervalsDays.length - 1);
  const days = retry.intervalsDays[idx];
  const next = new Date(now);
  next.setDate(next.getDate() + days);
  return next;
}
```

- [ ] **Step 4: 失败测试 `test/auto-renew-period.test.ts`**

```typescript
import { advancePeriod, billingPeriodKey } from "../src/services/auto-renew-period";
import { nextDeductRetry } from "../src/services/auto-renew-retry";

test("advancePeriod 按周期推进", () => {
  const from = new Date("2026-01-15T00:00:00Z");
  expect(advancePeriod("month", from).toISOString().slice(0, 10)).toBe("2026-02-15");
  expect(advancePeriod("year", from).toISOString().slice(0, 10)).toBe("2027-01-15");
});

test("billingPeriodKey 同订阅同周期同键", () => {
  const s = new Date("2026-01-15T08:00:00Z");
  expect(billingPeriodKey("sub1", s)).toBe("auto_renew:sub1:2026-01-15");
});

test("nextDeductRetry T+1/T+3 与上限", () => {
  const now = new Date("2026-01-15T00:00:00Z");
  const cfg = { intervalsDays: [1, 3], maxAttempts: 3 };
  expect(nextDeductRetry(1, now, cfg)!.toISOString().slice(0, 10)).toBe("2026-01-16"); // T+1
  expect(nextDeductRetry(2, now, cfg)!.toISOString().slice(0, 10)).toBe("2026-01-18"); // T+3
  expect(nextDeductRetry(3, now, cfg)).toBeNull();                                     // 超上限
});
```

- [ ] **Step 5: 通过 + 提交**

```bash
cd apps/api && bun test test/auto-renew-period.test.ts
git add apps/api/src/services/auto-renew-period.ts apps/api/src/services/auto-renew-retry.ts apps/api/test/auto-renew-period.test.ts
git commit -m "feat(spec305): 周期推进/幂等键/重试纯函数(advancePeriod/billingPeriodKey/nextDeductRetry)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 填充 `AlipayProvider` 的 sign/unsign/deduct（接 spec304 占位）

**Files:** Modify `apps/api/src/services/payment/alipay.ts`（spec304 已留 `NotImplementedError` 占位）；Create `apps/api/test/auto-renew-provider.test.ts`

> spec304 的 `AlipayProvider` 已声明 `sign/unsign/deduct` 默认抛 `NotImplementedError`。本 Task 用同一个 `alipay-sdk` 客户端把三方法填实，对应支付宝 `user.agreement.page.sign`/`user.agreement.unsign`/`trade.pay`（代扣场景，带 `agreement_no` 免确认）。签名与返回类型**严格遵循 spec304 接口**（`SignInput→{signUrl}`、`unsign(agreementNo)→{ok}`、`DeductInput→CallbackResult`），不改接口形状。

- [ ] **Step 1: 在 `alipay.ts` 用 SDK 实现三方法（替换 NotImplementedError 占位）**

```typescript
// user.agreement.page.sign：生成签约页（pageExec 返回带签名跳转 URL）
async sign(opts: SignInput): Promise<{ signUrl: string }> {
  const signUrl = this.sdk.pageExec("alipay.user.agreement.page.sign", {
    method: "GET",
    bizContent: {
      personal_product_code: "CYCLE_PAY_AUTH_P",
      sign_scene: "INDUSTRY|DIGITAL_MEDIA",
      external_agreement_no: opts.externalAgreementNo,
      access_params: { channel: "ALIPAYAPP" },
      period_rule_params: {
        period_type: opts.period === "month" ? "MONTH" : opts.period === "year" ? "MONTH" : "DAY",
        period: opts.period === "year" ? 12 : opts.period === "quarter" ? 3 : 1,
        single_amount: centsToYuan(opts.deductLimitCents),     // 单次扣款上限（元）
      },
    },
  });
  return { signUrl };
}

// user.agreement.unsign：解约
async unsign(agreementNo: string): Promise<{ ok: boolean }> {
  const res = await this.sdk.exec("alipay.user.agreement.unsign", {
    bizContent: { external_agreement_no: agreementNo, personal_product_code: "CYCLE_PAY_AUTH_P", sign_scene: "INDUSTRY|DIGITAL_MEDIA" },
  });
  return { ok: res.code === "10000" };
}

// trade.pay（代扣场景）：带 agreement_no 免用户确认，返回与单笔一致的 CallbackResult 形状
async deduct(opts: DeductInput): Promise<CallbackResult> {
  const res = await this.sdk.exec("alipay.trade.pay", {
    bizContent: {
      out_trade_no: opts.outTradeNo, subject: opts.subject,
      total_amount: centsToYuan(opts.amountCents),
      product_code: "CYCLE_PAY_AUTH", scene: "bar_code",      // 代扣场景
      agreement_params: { agreement_no: opts.agreementNo },
    },
  });
  const paid = res.code === "10000";
  return {
    verified: true, outTradeNo: opts.outTradeNo, tradeNo: (res.tradeNo as string) ?? "",
    status: paid ? "paid" : "failed",
    amountCents: res.totalAmount ? yuanToCents(res.totalAmount as string) : opts.amountCents,
  };
}
```

> 删掉 spec304 里这三个方法的 `throw new NotImplementedError(...)`。`SignInput`/`DeductInput`/`CallbackResult`/`centsToYuan`/`yuanToCents` 已由 spec304 `provider.ts` 导出，直接 import。

- [ ] **Step 2: 失败测试 `test/auto-renew-provider.test.ts`（mock SDK，不打网络）**

```typescript
import { AlipayProvider } from "../src/services/payment/alipay";
import type { AlipayEnvConfig } from "../src/services/payment/alipay-config";

const cfg: AlipayEnvConfig = {
  appId: "sandbox", privateKey: "pk", alipayPublicKey: "pub",
  gateway: "https://openapi.alipaydev.com/gateway.do", notifyUrl: "https://x/notify", signType: "RSA2",
};
function provider(over: Partial<any>): AlipayProvider {
  return new AlipayProvider({ exec: async () => ({ code: "10000" }), pageExec: () => "https://sign.url", ...over } as any, cfg);
}

test("sign 返回签约页 URL", async () => {
  const r = await provider({}).sign({ externalAgreementNo: "AG-1", planName: "P", period: "month", deductLimitCents: 100 });
  expect(r.signUrl).toContain("sign.url");
});

test("unsign code=10000 → ok", async () => {
  const r = await provider({ exec: async () => ({ code: "10000" }) }).unsign("AG-1");
  expect(r.ok).toBe(true);
});

test("deduct 成功 → status=paid + tradeNo", async () => {
  const r = await provider({ exec: async () => ({ code: "10000", tradeNo: "T-1", totalAmount: "1.00" }) })
    .deduct({ outTradeNo: "o1", agreementNo: "AG-1", subject: "续费", amountCents: 100 });
  expect(r.status).toBe("paid");
  expect(r.tradeNo).toBe("T-1");
});

test("deduct 失败 → status=failed", async () => {
  const r = await provider({ exec: async () => ({ code: "40004", msg: "BIZ" }) })
    .deduct({ outTradeNo: "o1", agreementNo: "AG-1", subject: "续费", amountCents: 100 });
  expect(r.status).toBe("failed");
});
```

- [ ] **Step 3: 通过 + 提交**

```bash
cd apps/api && bun test test/auto-renew-provider.test.ts
git add apps/api/src/services/payment/alipay.ts apps/api/test/auto-renew-provider.test.ts
git commit -m "feat(spec305): 填充 AlipayProvider sign/unsign/deduct(接 spec304 占位, 代扣场景)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 签约（sign + 回调落库 + auto_renew=true）

**Files:** Create `apps/api/src/services/auto-renew.ts`、`routes/auto-renew.ts`、`apps/api/test/auto-renew-sign.test.ts`

- [ ] **Step 1: 写 `services/auto-renew.ts` 的 `signAgreement` / `handleSignCallback`**

```typescript
import { randomUUID } from "node:crypto";
import { db } from "../db";
import { subscriptions, plans } from "../db/schema/plans";
import { paymentAgreements } from "../db/schema/payments";
import { eq } from "drizzle-orm";
import type { PaymentProvider } from "./payment/provider";   // spec304
import { advancePeriod } from "./auto-renew-period";

// (1) 生成签约页：本 spec 生成我方 agreementNo → provider.sign(opts)→{signUrl} → 落 signing 态 agreement
export async function signAgreement(
  provider: PaymentProvider, userId: string, planId: string,
): Promise<{ signPageUrl: string; agreementNo: string }> {
  const [plan] = await db.select().from(plans).where(eq(plans.id, planId));
  const agreementNo = randomUUID();                            // 我方签约号 = externalAgreementNo
  const { signUrl } = await provider.sign!({
    externalAgreementNo: agreementNo, planName: plan?.name ?? "会员",
    period: plan?.billingCycle ?? "month", deductLimitCents: plan?.priceCents ?? 0,
  });
  await db.insert(paymentAgreements).values({
    userId, planId, agreementNo, status: "signing",
    period: plan?.billingCycle, deductLimitCents: plan?.priceCents,
  });
  return { signPageUrl: signUrl, agreementNo };
}

// (2) 签约回调（已验签）：agreement=signed + external_no/next_deduct_at + subscriptions.auto_renew=true
export async function handleSignCallback(payload: {
  agreementNo: string; externalAgreementNo: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [ag] = await tx.select().from(paymentAgreements)
      .where(eq(paymentAgreements.agreementNo, payload.agreementNo));
    if (!ag) throw new Error("agreement 不存在");
    if (ag.status === "signed") return;                       // 幂等：重复回调忽略
    const [sub] = await tx.select().from(subscriptions)
      .where(eq(subscriptions.userId, ag.userId)).orderBy(subscriptions.createdAt);
    const periodEnd = sub?.currentPeriodEnd ?? advancePeriod(ag.period ?? "month", new Date());
    await tx.update(paymentAgreements).set({
      status: "signed", externalAgreementNo: payload.externalAgreementNo,
      nextDeductAt: periodEnd,                                // 当周期到期日扣下一期
    }).where(eq(paymentAgreements.id, ag.id));
    await tx.update(subscriptions).set({ autoRenew: true, agreementNo: payload.agreementNo })
      .where(eq(subscriptions.userId, ag.userId));
  });
}
```

- [ ] **Step 2: 写 `routes/auto-renew.ts`（签约接口 + 回调）**

```typescript
import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";          // Phase 0
import { signAgreement, handleSignCallback } from "../services/auto-renew";
import { getPaymentProvider } from "../services/payment";     // spec304 工厂

export const autoRenewRoutes = new Hono();

autoRenewRoutes.post("/sign", authMiddleware, async (c) => {
  const userId = c.get("userId") as string;
  const { planId } = z.object({ planId: z.string().uuid() }).parse(await c.req.json());
  const res = await signAgreement(getPaymentProvider("alipay"), userId, planId);
  return c.json(res);
});

// 支付宝异步签约回调（必须验签）：复用 spec304 provider.verifyCallback 验签
autoRenewRoutes.post("/sign/callback", async (c) => {
  const form = await c.req.parseBody();
  const raw = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, String(v)])) as Record<string, string>;
  const result = await getPaymentProvider("alipay").verifyCallback(raw);
  if (!result.verified) return c.text("failure", 400);        // 验签失败 → 拒绝
  // 签约通知：external_agreement_no = 我方 agreementNo；agreement_no = 支付宝侧签约号
  await handleSignCallback({
    agreementNo: String(raw.external_agreement_no),
    externalAgreementNo: String(raw.agreement_no),
  });
  return c.text("success");                                  // 支付宝要求返回 success
});
```

挂载到 App（`/api/subscriptions/auto-renew`）：
```typescript
app.route("/api/subscriptions/auto-renew", autoRenewRoutes);
```

- [ ] **Step 3: 失败测试 `test/auto-renew-sign.test.ts`（mock provider）**

```typescript
import { signAgreement, handleSignCallback } from "../src/services/auto-renew";
import { db } from "../src/db";
import { paymentAgreements } from "../src/db/schema/payments";
import { subscriptions } from "../src/db/schema/plans";
import { eq } from "drizzle-orm";

// mock 遵循 spec304 接口：sign(opts)→{signUrl}；agreementNo 由 signAgreement 内部生成
const mockProvider = {
  sign: async (_opts: any) => ({ signUrl: "https://alipay/sign?x=1" }),
} as any;

test("签约：生成签约页 + 回调落 signed + auto_renew=true", async () => {
  const { userId, planId, subId } = await seedUserPlanSub();   // 夹具：建 user/plan/active 订阅
  const { signPageUrl, agreementNo } = await signAgreement(mockProvider, userId, planId);
  expect(signPageUrl).toContain("alipay");
  // 回调前 signing
  let [ag] = await db.select().from(paymentAgreements).where(eq(paymentAgreements.agreementNo, agreementNo));
  expect(ag.status).toBe("signing");
  // 回调后 signed + auto_renew
  await handleSignCallback({ agreementNo, externalAgreementNo: "EXT-1" });
  [ag] = await db.select().from(paymentAgreements).where(eq(paymentAgreements.agreementNo, agreementNo));
  expect(ag.status).toBe("signed");
  expect(ag.externalAgreementNo).toBe("EXT-1");
  expect(ag.nextDeductAt).not.toBeNull();
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, subId));
  expect(sub.autoRenew).toBe(true);
  expect(sub.agreementNo).toBe(agreementNo);
});

test("回调幂等：重复回调不报错、状态不变", async () => {
  const { userId, planId } = await seedUserPlanSub();
  const { agreementNo } = await signAgreement(mockProvider, userId, planId);
  await handleSignCallback({ agreementNo, externalAgreementNo: "EXT-1" });
  await handleSignCallback({ agreementNo, externalAgreementNo: "EXT-1" });  // 第二次忽略
  const [ag] = await db.select().from(paymentAgreements).where(eq(paymentAgreements.agreementNo, agreementNo));
  expect(ag.status).toBe("signed");
});
```

- [ ] **Step 4: 通过 + 提交**

```bash
cd apps/api && bun test test/auto-renew-sign.test.ts
git add apps/api/src/services/auto-renew.ts apps/api/src/routes/auto-renew.ts apps/api/test/auto-renew-sign.test.ts
git commit -m "feat(spec305): 签约(sign 生成签约页 + 回调落 signed + auto_renew=true)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 解约（unsign + auto_renew=false，当周期保留至到期）

**Files:** Modify `services/auto-renew.ts`、`routes/auto-renew.ts`；Create `test/auto-renew-unsign.test.ts`

- [ ] **Step 1: 加 `unsignAgreement`**

```typescript
// 解约：provider.unsign(agreementNo)→{ok} → agreement=unsigned + subscriptions.auto_renew=false。
// 当周期权益保留（不动 status/currentPeriodEnd），到期由代扣 Cron/过期任务降级免费版。
export async function unsignAgreement(provider: PaymentProvider, userId: string): Promise<void> {
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
  if (!sub?.agreementNo) return;                              // 未签约 → 幂等返回
  const { ok } = await provider.unsign!(sub.agreementNo);
  if (!ok) throw new Error("解约失败");
  await db.transaction(async (tx) => {
    await tx.update(paymentAgreements).set({ status: "unsigned", nextDeductAt: null })
      .where(eq(paymentAgreements.agreementNo, sub.agreementNo!));
    await tx.update(subscriptions).set({ autoRenew: false })  // 不动 currentPeriodEnd（当周期保留）
      .where(eq(subscriptions.id, sub.id));
  });
}
```

加路由：
```typescript
autoRenewRoutes.post("/unsign", authMiddleware, async (c) => {
  await unsignAgreement(getPaymentProvider("alipay"), c.get("userId") as string);
  return c.json({ ok: true });
});
```

- [ ] **Step 2: 失败测试 `test/auto-renew-unsign.test.ts`**

```typescript
import { signAgreement, handleSignCallback, unsignAgreement } from "../src/services/auto-renew";

test("解约：auto_renew=false + agreement=unsigned + 当周期保留", async () => {
  const { userId, planId, subId } = await seedUserPlanSub();
  const calls: string[] = [];
  const provider = {
    sign: async () => ({ signUrl: "u" }),                     // agreementNo 由 signAgreement 内部生成
    unsign: async (no: string) => { calls.push(no); return { ok: true }; },
  } as any;
  const { agreementNo } = await signAgreement(provider, userId, planId);
  await handleSignCallback({ agreementNo, externalAgreementNo: "EXT-2" });
  const before = await getSub(subId);
  await unsignAgreement(provider, userId);
  expect(calls).toEqual([agreementNo]);                       // 用生成的 agreementNo 调 unsign
  const after = await getSub(subId);
  expect(after.autoRenew).toBe(false);
  expect(after.status).toBe("active");                        // 当周期保留，未降级
  expect(after.currentPeriodEnd).toEqual(before.currentPeriodEnd); // 周期未被改动
  const [ag] = await getAgreement(agreementNo);
  expect(ag.status).toBe("unsigned");
});
```

- [ ] **Step 3: 通过 + 提交**

```bash
cd apps/api && bun test test/auto-renew-unsign.test.ts
git add apps/api/src/services/auto-renew.ts apps/api/src/routes/auto-renew.ts apps/api/test/auto-renew-unsign.test.ts
git commit -m "feat(spec305): 解约(unsign + auto_renew=false, 当周期保留至到期)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 代扣成功路径（建幂等订单 → deduct → 续期 + 发积分 + 推进）

**Files:** Modify `services/auto-renew.ts`；Create `config/auto-renew.ts`、`test/auto-renew-deduct.test.ts`

- [ ] **Step 1: 写 `config/auto-renew.ts`**

```typescript
import { getConfig } from "../services/config";
import type { DeductRetryConfig } from "../services/auto-renew-retry";

export const AUTO_RENEW_ENABLED = process.env.AUTO_RENEW_ENABLED !== "false"; // 周期产品未过审 → 置 false 降级

export async function getDeductRetry(): Promise<DeductRetryConfig> {
  return (await getConfig<DeductRetryConfig>("deduct_retry")) ?? { intervalsDays: [1, 3], maxAttempts: 3 };
}
export async function getGrantExpireDays(): Promise<number> {
  return (await getConfig<number>("grant_expire_days")) ?? 30;
}
```

- [ ] **Step 2: 加 `deductOne`（单订阅扣款 + 续期成功路径）**

```typescript
import { paymentOrders } from "../db/schema/payments";
import { grant } from "./credits";                            // spec302
import { createOrder } from "./payment-orders";               // spec304 订单服务（建单幂等）
import { billingPeriodKey, advancePeriod } from "./auto-renew-period";
import { getGrantExpireDays } from "../config/auto-renew";

// 对单个到期订阅执行一次代扣；成功 → 续期+发积分+推进；失败 → 交给 Task6 重试。返回结果标记。
export async function deductOne(
  provider: PaymentProvider, sub: typeof subscriptions.$inferSelect, now: Date,
): Promise<"deducted" | "retry" | "past_due" | "skip"> {
  const [ag] = await db.select().from(paymentAgreements)
    .where(eq(paymentAgreements.agreementNo, sub.agreementNo!));
  if (!ag || ag.status !== "signed") return "skip";
  const [plan] = await db.select().from(plans).where(eq(plans.id, sub.planId));
  const periodStart = sub.currentPeriodEnd ?? now;            // 新周期起点 = 旧周期末
  const idemKey = billingPeriodKey(sub.id, periodStart);      // 幂等键 = 订阅+账单周期

  // 同周期已 paid → 直接返回（双触发不重复扣）
  const [existPaid] = await db.select().from(paymentOrders)
    .where(eq(paymentOrders.idempotencyKey, idemKey));
  if (existPaid?.status === "paid") return "skip";

  // 复用 spec304 订单服务建单（同 key 返回原单 → 幂等）
  const theOrder = await createOrder({
    userId: sub.userId, type: "auto_renew", amountCents: plan.priceCents, idempotencyKey: idemKey,
  });

  // spec304 deduct(opts)→CallbackResult：{ verified, outTradeNo, tradeNo, status, amountCents }
  const res = await provider.deduct!({
    outTradeNo: theOrder.id, agreementNo: sub.agreementNo!,
    subject: `${plan.name} 自动续费`, amountCents: plan.priceCents,
  });
  if (res.status !== "paid") return "retry";                  // 失败 → Task6 状态机

  // 成功：续期 + 发当期赠送积分 + 推进 next_deduct_at + 订单 paid（事务）
  await db.transaction(async (tx) => {
    const newEnd = advancePeriod(plan.billingCycle, periodStart);
    await tx.update(paymentOrders).set({ status: "paid", providerTradeNo: res.tradeNo })
      .where(eq(paymentOrders.id, theOrder.id));
    await tx.update(subscriptions).set({
      status: "active", currentPeriodStart: periodStart, currentPeriodEnd: newEnd,
    }).where(eq(subscriptions.id, sub.id));
    await tx.update(paymentAgreements).set({ nextDeductAt: newEnd })
      .where(eq(paymentAgreements.id, ag.id));
  });
  // 发当期赠送积分（幂等键 = 周期键，重复不重发）
  const expireAt = new Date(now); expireAt.setDate(expireAt.getDate() + (await getGrantExpireDays()));
  await grant(sub.userId, plan.grantCreditsPerCycle, {
    type: "grant", expireAt, ref: theOrder.id, idempotencyKey: `${idemKey}:grant`,
  });
  return "deducted";
}
```

- [ ] **Step 3: 失败测试 `test/auto-renew-deduct.test.ts`（mock provider）**

```typescript
import { deductOne } from "../src/services/auto-renew";
import { getBalance } from "../src/services/credits";

// mock 遵循 spec304 deduct→CallbackResult 形状
const okProvider = {
  deduct: async (o: any) => ({ verified: true, outTradeNo: o.outTradeNo, tradeNo: "T-1", status: "paid", amountCents: o.amountCents }),
} as any;

test("代扣成功：续期 + 发积分 + 推进 next_deduct_at", async () => {
  const { sub, agreementNo, planGrant } = await seedSignedSub({ periodEnd: new Date("2026-02-01") });
  const r = await deductOne(okProvider, sub, new Date("2026-02-01"));
  expect(r).toBe("deducted");
  const after = await getSub(sub.id);
  expect(after.status).toBe("active");
  expect(after.currentPeriodEnd.toISOString().slice(0, 10)).toBe("2026-03-01"); // 推进一个月
  const [ag] = await getAgreement(agreementNo);
  expect(ag.nextDeductAt.toISOString().slice(0, 10)).toBe("2026-03-01");
  expect(await getBalance(sub.userId)).toBe(planGrant);       // 发了当期赠送积分
});

test("同周期幂等键不重复扣：第二次 skip、积分不翻倍", async () => {
  const { sub, planGrant } = await seedSignedSub({ periodEnd: new Date("2026-02-01") });
  await deductOne(okProvider, sub, new Date("2026-02-01"));
  const subAfter1 = await getSub(sub.id);
  // 用「已续期但 next_deduct_at 仍指向旧周期」的方式再次触发同周期键 → skip
  const r2 = await deductOne(okProvider, { ...sub, currentPeriodEnd: new Date("2026-02-01") } as any, new Date("2026-02-01"));
  expect(r2).toBe("skip");
  expect(await getBalance(sub.userId)).toBe(planGrant);       // 仍是一份，未翻倍
});
```

- [ ] **Step 4: 通过 + 提交**

```bash
cd apps/api && bun test test/auto-renew-deduct.test.ts
git add apps/api/src/services/auto-renew.ts apps/api/src/config/auto-renew.ts apps/api/test/auto-renew-deduct.test.ts
git commit -m "feat(spec305): 代扣成功(幂等建单→deduct→续期+发积分+推进 next_deduct_at)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 失败重试状态机 + past_due 降级（不无限重试）

**Files:** Modify `services/auto-renew.ts`、`services/notify.ts`；Create `test/auto-renew-retry.test.ts`

- [ ] **Step 1: 写 `services/notify.ts`（推送提醒；首版写库 + console，留接口）**

```typescript
// 首版：落库一条提醒事件 + console.warn（真实推送渠道后续接入）。
export async function pushReminder(userId: string, kind: "past_due" | "renew_due", detail?: string): Promise<void> {
  console.warn(`[notify] user=${userId} kind=${kind} ${detail ?? ""}`);
  // TODO(spec308/后续): 落 notifications 表 + 站内信/短信渠道
}
```

- [ ] **Step 2: 加 `applyDeductFailure`（重试计数 + 推进 next_deduct_at / past_due 降级）**

重试计数靠「该订阅当周期 `payment_orders` 中 `auto_renew` 且 `failed` 的笔数」衡量（或在 agreement 上加 `deduct_attempts`；本计划用订单计数，避免改表）：

```typescript
import { nextDeductRetry } from "./auto-renew-retry";
import { getDeductRetry } from "../config/auto-renew";
import { pushReminder } from "./notify";
import { and, eq as eqd } from "drizzle-orm";

// 扣款失败：写 failed 订单（计数）→ 算下次重试时间；超 maxAttempts → past_due + 提醒 + 降级手动续费。
export async function applyDeductFailure(
  sub: typeof subscriptions.$inferSelect, now: Date,
): Promise<"retry" | "past_due"> {
  const periodStart = sub.currentPeriodEnd ?? now;
  const idemKey = billingPeriodKey(sub.id, periodStart);
  // 标记本周期订单 failed（幂等：同周期同键的订单已存在，更新为 failed）
  await db.update(paymentOrders).set({ status: "failed" })
    .where(eqd(paymentOrders.idempotencyKey, idemKey));
  // 本周期失败次数 = 已尝试次数
  const fails = await db.select().from(paymentOrders)
    .where(and(eqd(paymentOrders.idempotencyKey, idemKey), eqd(paymentOrders.status, "failed")));
  const attempts = fails.length;                              // ≥1
  const retry = await getDeductRetry();
  const next = nextDeductRetry(attempts, now, retry);
  const [ag] = await db.select().from(paymentAgreements)
    .where(eqd(paymentAgreements.agreementNo, sub.agreementNo!));

  if (next) {                                                 // 还能重试 → 推进 next_deduct_at
    await db.update(paymentAgreements).set({ nextDeductAt: next }).where(eqd(paymentAgreements.id, ag.id));
    return "retry";
  }
  // 超上限 → past_due + 停止代扣（next_deduct_at=null）+ 推送提醒 + 降级手动续费
  await db.transaction(async (tx) => {
    await tx.update(subscriptions).set({ status: "past_due", autoRenew: false }).where(eqd(subscriptions.id, sub.id));
    await tx.update(paymentAgreements).set({ nextDeductAt: null }).where(eqd(paymentAgreements.id, ag.id));
  });
  await pushReminder(sub.userId, "past_due", "自动续费多次失败，已转手动续费");
  return "past_due";
}
```

> **注意**：`deductOne` 的失败分支（返回 `"retry"`）由 cron 编排（Task 7）调 `applyDeductFailure` 落地；订单经 spec304 `createOrder` 同 `idempotencyKey` 复用同一条（同周期单条），重试不新建单、只翻状态。

- [ ] **Step 3: 失败测试 `test/auto-renew-retry.test.ts`**

```typescript
import { deductOne, applyDeductFailure } from "../src/services/auto-renew";

// mock 遵循 spec304 deduct→CallbackResult：失败 status="failed"
const failProvider = {
  deduct: async (o: any) => ({ verified: true, outTradeNo: o.outTradeNo, tradeNo: "", status: "failed", amountCents: o.amountCents }),
} as any;

test("扣款失败：进重试、推进 next_deduct_at（T+1）", async () => {
  await seedConfigs();                                         // deduct_retry intervalsDays=[1,3], maxAttempts=3
  const { sub, agreementNo } = await seedSignedSub({ periodEnd: new Date("2026-02-01") });
  expect(await deductOne(failProvider, sub, new Date("2026-02-01"))).toBe("retry");
  const r = await applyDeductFailure(sub, new Date("2026-02-01"));
  expect(r).toBe("retry");
  const [ag] = await getAgreement(agreementNo);
  expect(ag.nextDeductAt.toISOString().slice(0, 10)).toBe("2026-02-02"); // T+1
});

test("超 maxAttempts → past_due + auto_renew=false + 停止代扣", async () => {
  await seedConfigs();
  const { sub, agreementNo } = await seedSignedSub({ periodEnd: new Date("2026-02-01") });
  const now = new Date("2026-02-01");
  for (let i = 0; i < 3; i++) {                               // 3 次失败 → 达上限
    await deductOne(failProvider, sub, now);
    var last = await applyDeductFailure(sub, now);
  }
  expect(last).toBe("past_due");
  const after = await getSub(sub.id);
  expect(after.status).toBe("past_due");
  expect(after.autoRenew).toBe(false);                        // 降级手动续费
  const [ag] = await getAgreement(agreementNo);
  expect(ag.nextDeductAt).toBeNull();                         // 停止代扣，不无限重试
});
```

- [ ] **Step 4: 通过 + 提交**

```bash
cd apps/api && bun test test/auto-renew-retry.test.ts
git add apps/api/src/services/auto-renew.ts apps/api/src/services/auto-renew-retry.ts apps/api/src/services/notify.ts apps/api/test/auto-renew-retry.test.ts
git commit -m "feat(spec305): 失败重试状态机(T+1/T+3 计数) + 超上限 past_due 降级手动续费

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: 代扣 Cron 编排（startCronRunner 扫 next_deduct_at）

**Files:** Modify `services/auto-renew.ts`（`runDeductCycle` + `autoRenewJob`）；Create `cron/auto-renew-cron.ts`、`test/auto-renew-cron.test.ts`

- [ ] **Step 1: 加 `runDeductCycle`（job 体：扫描 + 逐订阅扣款，可直接调）**

```typescript
import { and, lte, eq as eqc } from "drizzle-orm";

// Cron job 体：扫 next_deduct_at<=now AND auto_renew=true 的订阅，逐个 deductOne，失败走 applyDeductFailure。
export async function runDeductCycle(
  provider: PaymentProvider, now: Date,
): Promise<{ scanned: number; deducted: number; retried: number; pastDue: number }> {
  const due = await db.select({ sub: subscriptions }).from(subscriptions)
    .innerJoin(paymentAgreements, eqc(subscriptions.agreementNo, paymentAgreements.agreementNo))
    .where(and(eqc(subscriptions.autoRenew, true), lte(paymentAgreements.nextDeductAt, now)));
  let deducted = 0, retried = 0, pastDue = 0;
  for (const { sub } of due) {
    const r = await deductOne(provider, sub, now);
    if (r === "deducted") deducted++;
    else if (r === "retry") {
      const f = await applyDeductFailure(sub, now);
      f === "past_due" ? pastDue++ : retried++;
    }
  }
  return { scanned: due.length, deducted, retried, pastDue };
}
```

- [ ] **Step 2: 加 `autoRenewJob`（无参 job 包装）+ 写 `cron/auto-renew-cron.ts`（CronJob 定义）**

`services/auto-renew.ts` 末尾加无参包装（供 spec303 `startCronRunner` 注册，job 体内取真实 provider + DB 当前时间）：

```typescript
import { getPaymentProvider } from "./payment";              // spec304 工厂

// spec303 CronJob 的 jobFn：无参、以 DB 为准、逐条幂等（双触发由幂等键兜底）。
export async function autoRenewJob(): Promise<void> {
  await runDeductCycle(getPaymentProvider("alipay"), new Date());
}
```

`cron/auto-renew-cron.ts`：产出 spec303 `CronJob` 定义（在 worker 入口 `startCronRunner([...])` 注册；`withCronLock` 由 `registerCron` 内部每 tick 自动包裹，无需手动调）：

```typescript
import type { CronJob } from "../services/cron";              // spec303
import { autoRenewJob, runRenewReminder } from "../services/auto-renew";
import { AUTO_RENEW_ENABLED } from "../config/auto-renew";

const EVERY_MS = 60 * 60 * 1000;                              // 每小时扫一次

// 按开关返回应注册的 cron job：开启 → 代扣；降级 → 到期提醒（Task 8）。
export function autoRenewCronJobs(): CronJob[] {
  return AUTO_RENEW_ENABLED
    ? [{ name: "auto-renew-deduct", everyMs: EVERY_MS, jobFn: autoRenewJob }]
    : [{ name: "auto-renew-reminder", everyMs: EVERY_MS, jobFn: async () => { await runRenewReminder(new Date()); } }];
}
```

> worker 入口（spec303 `startCronRunner`）：`startCronRunner([...autoRenewCronJobs(), /* spec306 对账/过期 job */])`。`registerCron` 每 tick 内部 `withCronLock("auto-renew-deduct", jobFn)` 抢 Redis 单例锁，集群内只一个实例执行；双触发由业务幂等键（`subscriptionId+周期`）兜底。

- [ ] **Step 3: 失败测试 `test/auto-renew-cron.test.ts`（直接调 job 体）**

```typescript
import { runDeductCycle } from "../src/services/auto-renew";

// mock 遵循 spec304 deduct→CallbackResult
const okProvider = {
  deduct: async (o: any) => ({ verified: true, outTradeNo: o.outTradeNo, tradeNo: "T", status: "paid", amountCents: o.amountCents }),
} as any;

test("runDeductCycle 只扫到期且 auto_renew 的订阅", async () => {
  const dueSub = await seedSignedSub({ periodEnd: new Date("2026-02-01"), nextDeductAt: new Date("2026-02-01") });
  const notDue = await seedSignedSub({ periodEnd: new Date("2026-05-01"), nextDeductAt: new Date("2026-05-01") });
  const res = await runDeductCycle(okProvider, new Date("2026-02-02"));
  expect(res.scanned).toBe(1);                                // 只 dueSub
  expect(res.deducted).toBe(1);
  expect((await getSub(notDue.sub.id)).currentPeriodEnd.toISOString().slice(0, 10)).toBe("2026-05-01"); // 未动
});

test("runDeductCycle 失败累计 retried/pastDue", async () => {
  await seedConfigs();
  const failProvider = {
    deduct: async (o: any) => ({ verified: true, outTradeNo: o.outTradeNo, tradeNo: "", status: "failed", amountCents: o.amountCents }),
  } as any;
  await seedSignedSub({ periodEnd: new Date("2026-02-01"), nextDeductAt: new Date("2026-02-01") });
  const res = await runDeductCycle(failProvider, new Date("2026-02-02"));
  expect(res.retried + res.pastDue).toBe(1);
});
```

- [ ] **Step 4: 通过 + 提交**

```bash
cd apps/api && bun test test/auto-renew-cron.test.ts
git add apps/api/src/services/auto-renew.ts apps/api/src/cron/auto-renew-cron.ts apps/api/test/auto-renew-cron.test.ts
git commit -m "feat(spec305): 代扣 Cron(registerCron 扫 next_deduct_at + withCronLock 单例 + 业务幂等兜底)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: 降级兜底（AUTO_RENEW_ENABLED=false → 到期提醒 + 手动续费）

**Files:** Modify `services/auto-renew.ts`；Create `test/auto-renew-fallback.test.ts`

> Cron 注册分支已在 Task 7 的 `autoRenewCronJobs()`（按 `AUTO_RENEW_ENABLED` 返回代扣 / 提醒 job）统一处理；本 Task 只补 `runRenewReminder` 业务体 + 测试。

- [ ] **Step 1: 加 `runRenewReminder`（到期前推送提醒，走单笔手动续费）**

```typescript
// 降级兜底：周期扣款产品未过审/不可用时，不代扣，仅在到期前 N 天推送「手动续费」提醒。
// 用户走 spec304 单笔支付续费（POST /api/payment/recharge 或购买套餐），不在本 cron 动钱。
export async function runRenewReminder(now: Date, leadDays = 3): Promise<{ reminded: number }> {
  const soon = new Date(now); soon.setDate(soon.getDate() + leadDays);
  const due = await db.select().from(subscriptions)
    .where(and(eqc(subscriptions.status, "active"), lte(subscriptions.currentPeriodEnd, soon)));
  for (const sub of due) await pushReminder(sub.userId, "renew_due", "会员即将到期，请手动续费");
  return { reminded: due.length };
}
```

- [ ] **Step 2: 失败测试 `test/auto-renew-fallback.test.ts`**

```typescript
import { runRenewReminder } from "../src/services/auto-renew";

test("降级：到期前推送手动续费提醒，不代扣", async () => {
  const { sub } = await seedSignedSub({ periodEnd: new Date("2026-02-02") }); // 3 天内到期
  const res = await runRenewReminder(new Date("2026-02-01"), 3);
  expect(res.reminded).toBe(1);
  const after = await getSub(sub.id);
  expect(after.currentPeriodEnd.toISOString().slice(0, 10)).toBe("2026-02-02"); // 未续期（不动钱）
});
```

- [ ] **Step 3: 通过 + 合并**

```bash
cd apps/api && bun test
git add apps/api/src/services/auto-renew.ts apps/api/test/auto-renew-fallback.test.ts
git commit -m "feat(spec305): 降级兜底(AUTO_RENEW_ENABLED=false → 到期提醒 + 手动续费, 收入不断档)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout main && git merge --no-ff phase3/spec305-auto-renew -m "merge spec305: 自动续费(周期代扣)"
git push origin main
```

---

## 验收清单（spec305）

- [ ] **AlipayProvider 代扣填充**：spec304 占位的 `sign/unsign/deduct` 用 `alipay-sdk` 实现（`user.agreement.page.sign`/`unsign`/`trade.pay` 代扣场景），签名/返回类型严格遵循 spec304 接口（`SignInput→{signUrl}`、`unsign→{ok}`、`DeductInput→CallbackResult`）。
- [ ] **签约**：`POST /api/subscriptions/auto-renew/sign {planId}` → 本 spec 生成 `agreementNo` → `provider.sign(opts)→{signUrl}` 生成签约页；回调复用 spec304 `verifyCallback` 验签 → 落 `payment_agreements`（signed/external_agreement_no/next_deduct_at/deduct_limit）+ `subscriptions.auto_renew=true` + 关联 agreement_no；回调幂等。
- [ ] **解约**：`POST /api/subscriptions/auto-renew/unsign` → `provider.unsign(agreementNo)→{ok}` → agreement=unsigned + auto_renew=false；当周期权益保留（status/currentPeriodEnd 不变），到期由 cron/过期降级免费版。
- [ ] **代扣成功**：经 spec304 `createOrder({type:"auto_renew", idempotencyKey=subscriptionId+账单周期})` 建单 → `provider.deduct(opts)→CallbackResult.status==="paid"` → 续期（推进 currentPeriodEnd/next_deduct_at）+ `credits.grant` 当期赠送积分 + 订单 paid。
- [ ] **同周期幂等**：同 `idempotency_key` 不重复扣、积分不翻倍（spec301 唯一约束 + `createOrder` 返原单 + 业务 skip 三兜底）。
- [ ] **失败重试状态机**：按 `deduct_retry.intervalsDays=[1,3]` T+1/T+3 推进 next_deduct_at；失败计数累加。
- [ ] **超上限降级**：达 `maxAttempts` → `subscriptions.status=past_due` + auto_renew=false + 停止代扣（next_deduct_at=null）+ 推送提醒 + 降级手动续费（不无限重试避风控）。
- [ ] **代扣 Cron**：产出 spec303 `CronJob`（`autoRenewJob`），由 worker 入口 `startCronRunner([...autoRenewCronJobs()])` 注册；`registerCron` 每 tick 内部 `withCronLock` 抢 Redis 单例锁；job 体可直接调；只扫 `next_deduct_at<=now AND auto_renew=true`。
- [ ] **降级兜底**：`AUTO_RENEW_ENABLED=false`（周期产品未过审）→ `autoRenewCronJobs()` 改返回到期提醒 job（`runRenewReminder`），引导用户走 spec304 单笔手动续费。
- [ ] 状态机：`payment_agreements.status: signing→signed→unsigned`、`subscriptions.status: active→past_due→expired`。
- [ ] 测试用 mock provider（`__setProviderForTest` 或直接传入）+ cron 直接调 job 体；`bun test` 全绿。
