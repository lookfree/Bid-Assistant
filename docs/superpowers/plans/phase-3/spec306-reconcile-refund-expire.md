# spec306 · 对账 + 退款 + 积分过期 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Phase 3 商业化的「资金校验与回退」三件套（架构 §6.3 对账 / §6.2(D) 退款 / §5.1 积分过期）：
1. **每日对账 Cron**——拉支付宝账单 vs `payment_orders` + `credit_transactions`，逐笔比对金额/状态，差异落 `reconcile_diffs` + 告警；积分账本独立审计（余额 = Σ流水）。
2. **退款流程**——`POST /api/admin/refunds`（运营发起）→ 建 `refunds(pending)` → `provider.refund` → 成功置 `done` + 订单 `refunded` + 必要时扣回已发积分（负向流水）/解约；失败 `failed`；敏感操作留审计。
3. **积分过期 Cron**——调 `credits.expireDue(now)` 写 `expire` 流水。

本 spec **只消费** spec302 账本、spec303 Cron、spec304 支付抽象，不重复实现它们；新增对账逻辑、退款编排、过期任务注册。

**Architecture:**
- **对账**：每日 `registerCron("reconcile", 1 天)` 调对账 job 体。job 用 `provider.queryBill(date)` 拉支付宝当日账单（逐笔 `{tradeNo, amountCents, status}`），与本地 `payment_orders`（按 `provider_trade_no` 关联）逐笔比对**金额**与**状态**；差异（金额不符/状态不符/单边账：本地有账单无、账单有本地无）写入 **`reconcile_diffs` 表**并触发**告警钩子**（`alertHook`，默认 console.error，可注入）。积分账本独立审计：抽样/全量校验 `credit_balances.balance === Σ credit_transactions.amount`，不一致也落 diff。**对账只读不改账**（差异交由人工/退款流程处置），保证幂等可重复跑。
- **退款**：运营在后台发起 `POST /api/admin/refunds {orderId, amount, reason}`（带 `operator`，来自 admin 会话；spec309 未就绪前先取 header/body 传入的 operator 字段 + TODO 注）。流程：①事务内建 `refunds(pending)` 并校验订单为 `paid`、退款额 ≤ 订单额；②调 `provider.refund({tradeNo, amountCents, outRequestNo})`；③成功 → `refunds.status=done` + `payment_orders.status=refunded` + （若该订单曾入账积分）写**负向积分流水**扣回 + （若关联 `payment_agreements`）解约置 `unsigned`；④失败 → `refunds.status=failed`。整个动作走**审计**（operator + 前后值），接 spec309 审计装置；spec309 未就绪先留 `operator` 字段 + `TODO(spec309)` 注释。
- **过期**：每日 `registerCron("credit_expire", 1 天)` 调 `credits.expireDue(now)`（spec302 已实现 FIFO 先过期先扣 + `expire:<grantId>` 幂等），写 `expire` 流水。Cron 体只是薄封装 + 日志。

**Tech Stack:** Hono 4.12、Bun、Drizzle ORM、PostgreSQL（事务）、Zod、Redis（Cron 锁，经 spec303）、bun:test。

## Global Constraints

见 `spec300-index.md`。本 spec 关键：
- **钱只在 App API 动**；对账是只读校验，不改账；退款是唯一会"扣回积分/解约"的运营动作，必须事务 + 审计。
- **余额 = Σ流水**：积分账本审计 = 校验 `credit_balances` 缓存与 `Σ credit_transactions` 一致。
- 周期任务（对账/过期）统一走 **Redis 分布式单例 Cron**（spec303 `registerCron`/`withCronLock`），不引入独立调度器；job 体幂等、可重复跑。
- 退款金额单位 `*_cents`(integer 分)；退款幂等（同 `out_request_no` 不重复退）。
- 敏感操作（退款）**一律留审计**（operator + 前后值），接 spec309；未就绪先留 operator + TODO。
- TDD（bun test）；`main` 上先开分支 `phase3/spec306-reconcile-refund-expire`。

---

## File Structure

```
apps/api/src/
├── db/schema/
│   └── reconcile.ts              # 新：reconcile_diffs（对账差异表）
├── services/
│   ├── reconcile.ts              # 新：对账 job 体（账单 vs orders+ledger + 账本审计）
│   └── refunds.ts                # 新：退款编排（建单→provider.refund→落账/扣积分/解约/审计）
├── cron/
│   ├── reconcile-job.ts          # 新：registerCron("reconcile", 1天) 注册
│   └── credit-expire-job.ts      # 新：registerCron("credit_expire", 1天) → credits.expireDue
└── routes/admin/
    └── refunds.ts                # 新：POST /api/admin/refunds（运营发起退款）
apps/api/test/
├── reconcile.test.ts             # 新：金额/状态差异检出 + 单边账 + 账本审计
├── refunds.test.ts               # 新：pending→done + 订单 refunded + 扣回积分 + 解约 + 失败 failed
└── credit-expire-job.test.ts     # 新：过期 job 调 expireDue 写 expire
```

> 文件按职责拆分，单文件不超 1000 行（用户全局约束）；Cron 注册与 job 体分离，便于测试直接调 job 体。

---

## Interfaces

**消费（来自前序 spec，不在本 spec 实现）：**
- spec303 Cron：`registerCron(name: string, intervalMs: number, job: () => Promise<void>): void`；`withCronLock(name: string, fn: () => Promise<void>): Promise<void>`（`registerCron` 内部已用 `withCronLock` 包裹保证分布式单例；本 spec 直接用 `registerCron`，job 体单独导出供测试直调）。
- spec302 账本：`credits.expireDue(now: Date) -> Promise<number>`；`credits.grant(userId, amount, opts)`（退积分用负向 amount，`type: "release"`/`"expire"` 语义，见 Task 2）。
- spec304 支付：`PaymentProvider` 接口，本 spec 要求其**扩展**两个方法（在 spec304 的 provider 接口上补，或本 spec 定义扩展接口 `ReconcilableProvider`）：
  - `queryBill(date: string /* YYYY-MM-DD */) -> Promise<Array<{ tradeNo: string; amountCents: number; status: "paid" | "refunded" | "closed" }>>`（拉当日账单）。
  - `refund(args: { tradeNo: string; amountCents: number; outRequestNo: string }) -> Promise<{ ok: boolean; refundedCents?: number; error?: string }>`（spec304 已声明 refund；本 spec 固定其入参/出参契约）。
- 表（spec301）：`paymentOrders`、`refunds`、`paymentAgreements`、`creditTransactions`、`creditBalances`。

**产出（供 spec310 运营后台 / 告警消费）：**
- `reconcileDiffs` 表对象。
- `runReconcile(date: string, deps: { provider, alertHook? }) -> Promise<{ checked: number; diffs: number }>`（对账 job 体，可直调测试）。
- `auditLedger() -> Promise<Array<{ userId: string; cached: number; actual: number }>>`（积分账本审计，返回不一致项）。
- `createRefund(input: { orderId; amountCents; reason; operator }, deps: { provider }) -> Promise<{ refundId; status }>`（退款编排，可直调测试 + 被 route 调用）。
- `expireCreditsJob()`（过期 job 体）。
- Cron 注册：`registerReconcileCron(deps)`、`registerCreditExpireCron()`。

---

## Task 1: 对账差异表 + 对账 job 体（账单 vs orders + 账本审计）

**Files:** Create `apps/api/src/db/schema/reconcile.ts`、`apps/api/src/services/reconcile.ts`、`apps/api/test/reconcile.test.ts`

- [ ] **Step 1: 开分支**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout -b phase3/spec306-reconcile-refund-expire
```

- [ ] **Step 2: 写 `db/schema/reconcile.ts`（对账差异表）**

```typescript
import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";

// 对账差异：每条记录一笔对不上的账（人工/退款流程处置；对账只读不改账）
export const reconcileDiffs = pgTable("reconcile_diffs", {
  id: uuid("id").defaultRandom().primaryKey(),
  billDate: text("bill_date").notNull(),                       // 对账日 YYYY-MM-DD
  // amount_mismatch(金额不符) | status_mismatch(状态不符) | bill_only(账单有本地无) | local_only(本地有账单无) | ledger_mismatch(账本余额≠Σ流水)
  diffType: text("diff_type").notNull(),
  tradeNo: text("trade_no"),                                   // 关联支付宝 trade_no（账本审计类为空）
  orderId: uuid("order_id"),                                   // 关联本地订单（单边账可空）
  userId: uuid("user_id"),                                     // 账本审计类记 user
  localValue: text("local_value"),                            // 本地侧值（金额/状态/缓存余额）
  billValue: text("bill_value"),                              // 账单侧值（金额/状态/Σ流水）
  resolved: text("resolved").notNull().default("open"),       // open/resolved（人工处置后置 resolved）
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({ dateIdx: index("reconcile_diffs_date_idx").on(t.billDate) }));
```

- [ ] **Step 3: 失败测试 `test/reconcile.test.ts`（先写金额/状态差异检出）**

```typescript
import { runReconcile } from "../src/services/reconcile";
import { db } from "../src/db";
import { paymentOrders } from "../src/db/schema/payments";
import { reconcileDiffs } from "../src/db/schema/reconcile";
import { eq } from "drizzle-orm";

// mock provider：可控账单
function mockProvider(bill: Array<{ tradeNo: string; amountCents: number; status: string }>) {
  return { queryBill: async (_d: string) => bill } as any;
}

test("金额不符 → 落 amount_mismatch", async () => {
  const userId = await makeTestUser();
  const [order] = await db.insert(paymentOrders).values({
    userId, type: "recharge", amountCents: 1000, status: "paid",
    provider: "alipay", providerTradeNo: "T1", idempotencyKey: "o1",
  }).returning();
  // 账单金额 999，本地 1000 → 金额不符
  const res = await runReconcile("2026-06-29", {
    provider: mockProvider([{ tradeNo: "T1", amountCents: 999, status: "paid" }]),
  });
  expect(res.diffs).toBe(1);
  const [d] = await db.select().from(reconcileDiffs).where(eq(reconcileDiffs.tradeNo, "T1"));
  expect(d.diffType).toBe("amount_mismatch");
  expect(d.localValue).toBe("1000");
  expect(d.billValue).toBe("999");
});

test("状态不符 → 落 status_mismatch（本地 paid，账单 refunded）", async () => {
  const userId = await makeTestUser();
  await db.insert(paymentOrders).values({
    userId, type: "recharge", amountCents: 500, status: "paid",
    provider: "alipay", providerTradeNo: "T2", idempotencyKey: "o2",
  });
  const res = await runReconcile("2026-06-29", {
    provider: mockProvider([{ tradeNo: "T2", amountCents: 500, status: "refunded" }]),
  });
  expect(res.diffs).toBe(1);
  const [d] = await db.select().from(reconcileDiffs).where(eq(reconcileDiffs.tradeNo, "T2"));
  expect(d.diffType).toBe("status_mismatch");
});

test("单边账：账单有本地无 → bill_only；本地有账单无 → local_only", async () => {
  const userId = await makeTestUser();
  await db.insert(paymentOrders).values({
    userId, type: "recharge", amountCents: 300, status: "paid",
    provider: "alipay", providerTradeNo: "T_LOCAL", idempotencyKey: "o3",
  });
  const res = await runReconcile("2026-06-29", {
    provider: mockProvider([{ tradeNo: "T_BILL", amountCents: 700, status: "paid" }]),
  });
  expect(res.diffs).toBe(2);
  const rows = await db.select().from(reconcileDiffs);
  const types = rows.map((r) => r.diffType).sort();
  expect(types).toContain("bill_only");
  expect(types).toContain("local_only");
});

test("对账一致 → 无差异；可重复跑（幂等不重复落 diff）", async () => {
  const userId = await makeTestUser();
  await db.insert(paymentOrders).values({
    userId, type: "recharge", amountCents: 800, status: "paid",
    provider: "alipay", providerTradeNo: "T_OK", idempotencyKey: "o4",
  });
  const bill = [{ tradeNo: "T_OK", amountCents: 800, status: "paid" }];
  const r1 = await runReconcile("2026-06-29", { provider: mockProvider(bill) });
  const r2 = await runReconcile("2026-06-29", { provider: mockProvider(bill) });
  expect(r1.diffs).toBe(0);
  expect(r2.diffs).toBe(0);
});
```

- [ ] **Step 4: 写 `services/reconcile.ts`（对账 job 体 + 账本审计）**

要点：
- `runReconcile(date, deps)`：拉 `deps.provider.queryBill(date)` → 当日 `payment_orders`（按 `created_at` 落在该日，或简化全量按 `providerTradeNo` 关联）。
- 用 `Map<tradeNo, order>` + `Map<tradeNo, billItem>` 做双向比对：
  - 两侧都有：金额不符 → `amount_mismatch`；状态不符（映射本地 `paid/refunded/failed` ↔ 账单 `paid/refunded/closed`）→ `status_mismatch`。
  - 仅账单有 → `bill_only`；仅本地有（且本地 `paid`）→ `local_only`。
- **幂等**：落 diff 前先查同 `(billDate, tradeNo, diffType)` 是否已存在 `open`，存在则跳过（避免重复跑重复落）。
- 状态状态映射表集中定义，注释清楚口径（本地 `created` 不参与对账，只比已支付/已退款）。
- 返回 `{ checked, diffs }`。

```typescript
import { db } from "../db";
import { paymentOrders } from "../db/schema/payments";
import { reconcileDiffs } from "../db/schema/reconcile";
import { creditTransactions, creditBalances } from "../db/schema/credits";
import { and, eq, sql } from "drizzle-orm";

export type BillItem = { tradeNo: string; amountCents: number; status: string };
export interface ReconcilableProvider { queryBill(date: string): Promise<BillItem[]>; }
export type AlertHook = (msg: string, detail: unknown) => void;

const defaultAlert: AlertHook = (msg, detail) => console.error(`[reconcile] ${msg}`, detail);

// 本地状态 ↔ 账单状态 是否一致（口径集中处）
function statusMatch(local: string, bill: string): boolean {
  if (local === "paid") return bill === "paid";
  if (local === "refunded") return bill === "refunded" || bill === "closed";
  return false; // created/failed 不应出现在账单已支付侧
}

async function recordDiff(d: typeof reconcileDiffs.$inferInsert, alert: AlertHook) {
  // 幂等：同 (billDate, tradeNo, diffType) 已有 open 则跳过
  const existing = await db.select().from(reconcileDiffs).where(and(
    eq(reconcileDiffs.billDate, d.billDate),
    d.tradeNo ? eq(reconcileDiffs.tradeNo, d.tradeNo) : sql`${reconcileDiffs.tradeNo} is null`,
    eq(reconcileDiffs.diffType, d.diffType),
    eq(reconcileDiffs.resolved, "open"),
  ));
  if (existing.length) return false;
  await db.insert(reconcileDiffs).values(d);
  alert(`差异: ${d.diffType}`, d);
  return true;
}

export async function runReconcile(
  date: string,
  deps: { provider: ReconcilableProvider; alertHook?: AlertHook },
): Promise<{ checked: number; diffs: number }> {
  const alert = deps.alertHook ?? defaultAlert;
  const bill = await deps.provider.queryBill(date);
  // 本地：已结算（paid/refunded）的订单（created/failed 不对账）
  const orders = (await db.select().from(paymentOrders))
    .filter((o) => o.providerTradeNo && (o.status === "paid" || o.status === "refunded"));
  const orderByTrade = new Map(orders.map((o) => [o.providerTradeNo!, o]));
  const billByTrade = new Map(bill.map((b) => [b.tradeNo, b]));
  let diffs = 0;

  for (const b of bill) {
    const o = orderByTrade.get(b.tradeNo);
    if (!o) { if (await recordDiff({ billDate: date, diffType: "bill_only", tradeNo: b.tradeNo, billValue: String(b.amountCents) }, alert)) diffs++; continue; }
    if (o.amountCents !== b.amountCents) { if (await recordDiff({ billDate: date, diffType: "amount_mismatch", tradeNo: b.tradeNo, orderId: o.id, localValue: String(o.amountCents), billValue: String(b.amountCents) }, alert)) diffs++; }
    if (!statusMatch(o.status, b.status)) { if (await recordDiff({ billDate: date, diffType: "status_mismatch", tradeNo: b.tradeNo, orderId: o.id, localValue: o.status, billValue: b.status }, alert)) diffs++; }
  }
  for (const o of orders) {
    if (!billByTrade.has(o.providerTradeNo!)) { if (await recordDiff({ billDate: date, diffType: "local_only", tradeNo: o.providerTradeNo!, orderId: o.id, localValue: o.status }, alert)) diffs++; }
  }
  return { checked: bill.length + orders.length, diffs };
}

// 积分账本独立审计：缓存余额 vs Σ流水（不一致落 ledger_mismatch + 告警）
export async function auditLedger(
  date = new Date().toISOString().slice(0, 10),
  alertHook: AlertHook = defaultAlert,
): Promise<Array<{ userId: string; cached: number; actual: number }>> {
  const sums = await db.select({
    userId: creditTransactions.userId,
    actual: sql<number>`coalesce(sum(${creditTransactions.amount}),0)`,
  }).from(creditTransactions).groupBy(creditTransactions.userId);
  const balances = await db.select().from(creditBalances);
  const cacheMap = new Map(balances.map((b) => [b.userId, b.balance]));
  const bad: Array<{ userId: string; cached: number; actual: number }> = [];
  for (const s of sums) {
    const cached = cacheMap.get(s.userId) ?? 0;
    const actual = Number(s.actual);
    if (cached !== actual) {
      bad.push({ userId: s.userId, cached, actual });
      await db.insert(reconcileDiffs).values({ billDate: date, diffType: "ledger_mismatch", userId: s.userId, localValue: String(cached), billValue: String(actual) });
      alertHook("账本审计不一致", { userId: s.userId, cached, actual });
    }
  }
  return bad;
}
```

- [ ] **Step 5: 生成迁移 + 账本审计测试 + 跑通**

```typescript
import { auditLedger } from "../src/services/reconcile";
import { creditTransactions, creditBalances } from "../src/db/schema/credits";

test("账本审计：缓存余额 ≠ Σ流水 → 落 ledger_mismatch", async () => {
  const userId = await makeTestUser();
  await db.insert(creditTransactions).values({ userId, type: "grant", amount: 100, idempotencyKey: "a1" });
  await db.insert(creditBalances).values({ userId, balance: 80 }); // 故意写错缓存
  const bad = await auditLedger("2026-06-29", () => {});
  expect(bad).toEqual([{ userId, cached: 80, actual: 100 }]);
});
```

```bash
cd apps/api && bun run drizzle-kit generate && bun test test/reconcile.test.ts
```

- [ ] **Step 6: 提交**

```bash
git add apps/api/src/db/schema/reconcile.ts apps/api/src/services/reconcile.ts apps/api/drizzle apps/api/test/reconcile.test.ts
git commit -m "feat(spec306): 对账(账单 vs orders 金额/状态/单边账 + 账本审计) + reconcile_diffs 表

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 退款编排（建单 → provider.refund → 落账 / 扣回积分 / 解约 / 审计）

**Files:** Create `apps/api/src/services/refunds.ts`、`apps/api/test/refunds.test.ts`

- [ ] **Step 1: 失败测试 `test/refunds.test.ts`（pending→done 全链路）**

```typescript
import { createRefund } from "../src/services/refunds";
import { db } from "../src/db";
import { paymentOrders, refunds, paymentAgreements } from "../src/db/schema/payments";
import { creditTransactions } from "../src/db/schema/credits";
import { eq } from "drizzle-orm";

function okProvider() {
  return { refund: async (a: { amountCents: number }) => ({ ok: true, refundedCents: a.amountCents }) } as any;
}
function failProvider() {
  return { refund: async () => ({ ok: false, error: "REFUND_REJECTED" }) } as any;
}

test("退款成功：refunds pending→done + 订单 refunded + 扣回积分", async () => {
  const userId = await makeTestUser();
  const [order] = await db.insert(paymentOrders).values({
    userId, type: "recharge", amountCents: 1000, status: "paid",
    provider: "alipay", providerTradeNo: "T1", idempotencyKey: "o1",
  }).returning();
  // 该订单曾入账 1000 积分（充值到账）
  await db.insert(creditTransactions).values({ userId, type: "purchase", amount: 1000, ref: order.id, idempotencyKey: "grant:o1" });

  const res = await createRefund(
    { orderId: order.id, amountCents: 1000, reason: "用户申请", operator: "ops_alice" },
    { provider: okProvider() },
  );
  expect(res.status).toBe("done");

  const [r] = await db.select().from(refunds).where(eq(refunds.id, res.refundId));
  expect(r.status).toBe("done");
  expect(r.operator).toBe("ops_alice");
  const [o] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, order.id));
  expect(o.status).toBe("refunded");
  // 扣回积分：写了一笔负向流水
  const txs = await db.select().from(creditTransactions).where(eq(creditTransactions.userId, userId));
  const negative = txs.filter((t) => t.amount < 0);
  expect(negative.length).toBe(1);
  expect(negative[0].amount).toBe(-1000);
});

test("退款成功且订单关联代扣协议：解约 unsigned", async () => {
  const userId = await makeTestUser();
  const [ag] = await db.insert(paymentAgreements).values({
    userId, provider: "alipay", agreementNo: "AG1", status: "signed",
  }).returning();
  const [order] = await db.insert(paymentOrders).values({
    userId, type: "auto_renew", amountCents: 2900, status: "paid",
    provider: "alipay", providerTradeNo: "T2", idempotencyKey: "o2",
  }).returning();
  await createRefund(
    { orderId: order.id, amountCents: 2900, reason: "扣款后退款", operator: "ops_bob", agreementNo: "AG1" },
    { provider: okProvider() },
  );
  const [a] = await db.select().from(paymentAgreements).where(eq(paymentAgreements.id, ag.id));
  expect(a.status).toBe("unsigned");
});

test("退款失败：refunds failed，订单不变，不扣积分", async () => {
  const userId = await makeTestUser();
  const [order] = await db.insert(paymentOrders).values({
    userId, type: "recharge", amountCents: 500, status: "paid",
    provider: "alipay", providerTradeNo: "T3", idempotencyKey: "o3",
  }).returning();
  const res = await createRefund(
    { orderId: order.id, amountCents: 500, reason: "测试失败", operator: "ops_carol" },
    { provider: failProvider() },
  );
  expect(res.status).toBe("failed");
  const [o] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, order.id));
  expect(o.status).toBe("paid");                               // 不变
  const txs = await db.select().from(creditTransactions).where(eq(creditTransactions.userId, userId));
  expect(txs.filter((t) => t.amount < 0).length).toBe(0);      // 没扣积分
});

test("拒绝非法退款：订单非 paid / 超额", async () => {
  const userId = await makeTestUser();
  const [order] = await db.insert(paymentOrders).values({
    userId, type: "recharge", amountCents: 500, status: "created",
    provider: "alipay", providerTradeNo: "T4", idempotencyKey: "o4",
  }).returning();
  await expect(createRefund(
    { orderId: order.id, amountCents: 500, reason: "x", operator: "ops" },
    { provider: okProvider() },
  )).rejects.toThrow();
});
```

- [ ] **Step 2: 写 `services/refunds.ts`（退款编排）**

要点：
- 入参 Zod 校验：`{ orderId: uuid, amountCents: int>0, reason: string, operator: string, agreementNo?: string }`。
- ①事务建 `refunds(pending)` + 校验：订单存在且 `status==="paid"`；`amountCents <= order.amountCents`（不满足抛错，不建 provider 调用）。
- ②`out_request_no = refunds.id`（退款幂等键，同一退款重试不重复退）。调 `deps.provider.refund({ tradeNo: order.providerTradeNo, amountCents, outRequestNo })`。
- ③成功（`ok`）：事务内 `refunds.status=done` + `payment_orders.status=refunded` + 若该订单曾入账积分（按 `ref===order.id` 查 `purchase/grant` 正向流水之和 > 0）则写**负向流水** `type:"release"` `amount: -refunded`（`idempotencyKey: refund:${refundId}`，幂等）+ 若 `agreementNo` 给定则该协议 `status=unsigned`。
- ④失败：`refunds.status=failed`，不动订单/积分/协议。
- **审计**：成功/失败都写审计（operator + 前值后值）。spec309 审计装置就绪则调 `audit.log({ operator, action:"refund", orderId, before, after })`；未就绪先留 `operator` 字段写进 `refunds` + 顶部 `TODO(spec309): 接 admin_audit_logs 审计装置`。

```typescript
import { z } from "zod";
import { db } from "../db";
import { paymentOrders, refunds, paymentAgreements } from "../db/schema/payments";
import { creditTransactions } from "../db/schema/credits";
import { and, eq, sql } from "drizzle-orm";

// TODO(spec309): 接 admin_audit_logs 审计装置（operator + 前后值）；当前先把 operator 落 refunds + console 审计
function auditLog(entry: { operator: string; action: string; orderId: string; before: unknown; after: unknown }) {
  console.info("[audit]", entry); // spec309 就绪后替换为 admin_audit_logs 写入
}

export interface RefundProvider {
  refund(args: { tradeNo: string; amountCents: number; outRequestNo: string }): Promise<{ ok: boolean; refundedCents?: number; error?: string }>;
}

const InputSchema = z.object({
  orderId: z.string().uuid(),
  amountCents: z.number().int().positive(),
  reason: z.string(),
  operator: z.string().min(1),
  agreementNo: z.string().optional(),
});
export type RefundInput = z.infer<typeof InputSchema>;

export async function createRefund(
  rawInput: RefundInput,
  deps: { provider: RefundProvider },
): Promise<{ refundId: string; status: "done" | "failed" }> {
  const input = InputSchema.parse(rawInput);

  // ① 事务：校验订单 + 建 pending 退款单
  const { order, refundId } = await db.transaction(async (tx) => {
    const [order] = await tx.select().from(paymentOrders).where(eq(paymentOrders.id, input.orderId));
    if (!order) throw new Error("订单不存在");
    if (order.status !== "paid") throw new Error(`订单状态非 paid：${order.status}`);
    if (input.amountCents > order.amountCents) throw new Error("退款额超过订单额");
    const [r] = await tx.insert(refunds).values({
      orderId: order.id, amountCents: input.amountCents, reason: input.reason,
      status: "pending", operator: input.operator,
    }).returning();
    return { order, refundId: r.id };
  });

  // ② 调 provider（out_request_no = refundId，幂等）
  let result: { ok: boolean; refundedCents?: number; error?: string };
  try {
    result = await deps.provider.refund({ tradeNo: order.providerTradeNo!, amountCents: input.amountCents, outRequestNo: refundId });
  } catch (e) {
    result = { ok: false, error: (e as Error).message };
  }

  if (!result.ok) {
    await db.update(refunds).set({ status: "failed" }).where(eq(refunds.id, refundId));
    auditLog({ operator: input.operator, action: "refund.failed", orderId: order.id, before: { orderStatus: order.status }, after: { refundStatus: "failed", error: result.error } });
    return { refundId, status: "failed" };
  }

  // ③ 成功：事务落账 + 扣回积分 + 解约
  await db.transaction(async (tx) => {
    await tx.update(refunds).set({ status: "done" }).where(eq(refunds.id, refundId));
    await tx.update(paymentOrders).set({ status: "refunded" }).where(eq(paymentOrders.id, order.id));

    // 该订单曾入账的积分（按 ref=order.id 的正向充值/赠送）→ 写负向扣回
    const [granted] = await tx.select({ total: sql<number>`coalesce(sum(${creditTransactions.amount}),0)` })
      .from(creditTransactions)
      .where(and(eq(creditTransactions.ref, order.id), sql`${creditTransactions.amount} > 0`));
    const grantedCredits = Number(granted?.total ?? 0);
    if (grantedCredits > 0) {
      // 简化：按退款比例扣回（全额退则全扣）
      const refundRatio = input.amountCents / order.amountCents;
      const clawback = Math.round(grantedCredits * refundRatio);
      await tx.insert(creditTransactions).values({
        userId: order.userId, type: "release", amount: -clawback, ref: order.id,
        idempotencyKey: `refund:${refundId}`,
      }).onConflictDoNothing({ target: creditTransactions.idempotencyKey });
    }

    // 关联代扣协议 → 解约
    if (input.agreementNo) {
      await tx.update(paymentAgreements).set({ status: "unsigned" }).where(eq(paymentAgreements.agreementNo, input.agreementNo));
    }
  });

  auditLog({ operator: input.operator, action: "refund.done", orderId: order.id, before: { orderStatus: "paid" }, after: { orderStatus: "refunded", refundId, amountCents: input.amountCents } });
  return { refundId, status: "done" };
}
```

- [ ] **Step 3: 通过 + 提交**

```bash
cd apps/api && bun test test/refunds.test.ts
git add apps/api/src/services/refunds.ts apps/api/test/refunds.test.ts
git commit -m "feat(spec306): 退款编排(pending→done/failed + 订单 refunded + 扣回积分 + 解约 + 审计占位)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 退款 Admin 路由（POST /api/admin/refunds）

**Files:** Create `apps/api/src/routes/admin/refunds.ts`、Modify `apps/api/test/refunds.test.ts`（加 route 层测试）

- [ ] **Step 1: 写 `routes/admin/refunds.ts`**

要点：
- Hono router；`POST /api/admin/refunds`，body Zod 校验 `{ orderId, amount, reason }`。
- `operator` 来源：spec309 就绪后取 admin 会话 `c.get("admin").username`；未就绪先取 header `x-admin-operator` 或 body `operator`（带 `TODO(spec309)` 注）。
- 注入真实 provider（spec304 的 `AlipayProvider` 实例，实现 `refund`），调 `createRefund`。
- 返回 `{ refundId, status }`；校验失败 → 400；订单非法 → 422。

```typescript
import { Hono } from "hono";
import { z } from "zod";
import { createRefund } from "../../services/refunds";
import { getPaymentProvider } from "../../services/payment-provider"; // spec304 提供的 provider 单例（含 refund）

const Body = z.object({ orderId: z.string().uuid(), amount: z.number().int().positive(), reason: z.string().min(1) });

export const adminRefundsRouter = new Hono();

adminRefundsRouter.post("/api/admin/refunds", async (c) => {
  const parsed = Body.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  // TODO(spec309): operator 取 admin 会话；当前从 header/body 兜底
  const operator = c.req.header("x-admin-operator") ?? "unknown";
  try {
    const res = await createRefund(
      { orderId: parsed.data.orderId, amountCents: parsed.data.amount, reason: parsed.data.reason, operator },
      { provider: getPaymentProvider() },
    );
    return c.json(res);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 422);
  }
});
```

> 若 spec304 的 provider 单例导出名不同（如 `paymentProvider`/`alipayProvider`），落地时按实际命名引入；route 只负责取 operator + 调 `createRefund`，逻辑全在 service。

- [ ] **Step 2: 失败测试（route 层：合法请求 done / 非法订单 422 / 缺字段 400）**

```typescript
import { adminRefundsRouter } from "../src/routes/admin/refunds";
// 用 app.request 调路由；mock getPaymentProvider 返回 okProvider（或在测试环境注入）

test("POST /api/admin/refunds 合法 → 200 done", async () => {
  // 建 paid 订单后
  const res = await adminRefundsRouter.request("/api/admin/refunds", {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-operator": "ops_test" },
    body: JSON.stringify({ orderId, amount: 1000, reason: "退" }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).status).toBe("done");
});

test("POST /api/admin/refunds 缺字段 → 400", async () => {
  const res = await adminRefundsRouter.request("/api/admin/refunds", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "x" }),
  });
  expect(res.status).toBe(400);
});
```

> provider 注入：测试中可对 `getPaymentProvider` 做 mock（`mock.module` / 依赖注入）。若 spec304 未导出可 mock 的工厂，落地时把 `getPaymentProvider` 设计成可覆盖（如读环境标志返回 stub provider）。

- [ ] **Step 3: 挂载路由 + 通过 + 提交**

把 `adminRefundsRouter` 挂到主 app（`app.route("/", adminRefundsRouter)` 或现有 admin 聚合）。

```bash
cd apps/api && bun test test/refunds.test.ts
git add apps/api/src/routes/admin/refunds.ts apps/api/src/app.ts apps/api/test/refunds.test.ts
git commit -m "feat(spec306): POST /api/admin/refunds 运营发起退款路由(operator 兜底 + TODO spec309)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 积分过期 Cron（registerCron credit_expire → credits.expireDue）

**Files:** Create `apps/api/src/cron/credit-expire-job.ts`、`apps/api/test/credit-expire-job.test.ts`

- [ ] **Step 1: 失败测试 `test/credit-expire-job.test.ts`**

```typescript
import { expireCreditsJob } from "../src/cron/credit-expire-job";
import { grant, getBalance } from "../src/services/credits";

test("过期 job 调 expireDue：到期批次写 expire 流水", async () => {
  const userId = await makeTestUser();
  const past = new Date(Date.now() - 86400_000);
  await grant(userId, 50, { idempotencyKey: "exp1", expireAt: past });
  expect(await getBalance(userId)).toBe(50);
  await expireCreditsJob();                                    // 直调 job 体
  expect(await getBalance(userId)).toBe(0);                   // 过期注销
});
```

- [ ] **Step 2: 写 `cron/credit-expire-job.ts`（job 体 + Cron 注册）**

```typescript
import { registerCron } from "../services/cron";   // spec303
import { expireDue } from "../services/credits";    // spec302

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** 过期 job 体：调账本 FIFO 过期（幂等，spec302 已保证 expire:<grantId> 不重复）。可直调测试。 */
export async function expireCreditsJob(): Promise<void> {
  const expired = await expireDue(new Date());
  console.info(`[cron:credit_expire] 过期注销积分 ${expired}`);
}

/** 注册每日过期 Cron（Redis 分布式单例，spec303 registerCron 内部已加锁）。 */
export function registerCreditExpireCron(): void {
  registerCron("credit_expire", ONE_DAY_MS, expireCreditsJob);
}
```

> 引入路径以 spec303 实际导出为准（`registerCron` 可能在 `services/cron.ts`）。job 体单独导出 → 测试直调，不依赖 Redis/定时器。

- [ ] **Step 3: 通过 + 提交**

```bash
cd apps/api && bun test test/credit-expire-job.test.ts
git add apps/api/src/cron/credit-expire-job.ts apps/api/test/credit-expire-job.test.ts
git commit -m "feat(spec306): 积分过期 Cron(registerCron credit_expire → credits.expireDue)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 对账 Cron 注册 + 接线 startup

**Files:** Create `apps/api/src/cron/reconcile-job.ts`、Modify startup（`apps/api/src/index.ts` 或 cron 聚合）、Modify `apps/api/test/reconcile.test.ts`

- [ ] **Step 1: 写 `cron/reconcile-job.ts`（注册每日对账）**

```typescript
import { registerCron } from "../services/cron";        // spec303
import { runReconcile, auditLedger, type ReconcilableProvider, type AlertHook } from "../services/reconcile";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** 对账 job 体：对账昨日账单 + 账本审计。可直调测试。 */
export async function reconcileJob(deps: { provider: ReconcilableProvider; alertHook?: AlertHook }): Promise<void> {
  const date = new Date(Date.now() - ONE_DAY_MS).toISOString().slice(0, 10); // 对昨日账
  const r = await runReconcile(date, deps);
  await auditLedger(date, deps.alertHook);
  console.info(`[cron:reconcile] ${date} checked=${r.checked} diffs=${r.diffs}`);
}

/** 注册每日对账 Cron（Redis 分布式单例）。provider 来自 spec304（须实现 queryBill）。 */
export function registerReconcileCron(deps: { provider: ReconcilableProvider; alertHook?: AlertHook }): void {
  registerCron("reconcile", ONE_DAY_MS, () => reconcileJob(deps));
}
```

- [ ] **Step 2: 测试（reconcileJob 直调：对账 + 审计一起跑）**

```typescript
import { reconcileJob } from "../src/cron/reconcile-job";

test("reconcileJob：对账昨日并跑账本审计（mock provider）", async () => {
  // 建一笔金额不符的订单（trade T1），账单返回不同金额
  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  // ...建 paid 订单 providerTradeNo=T1 amountCents=1000...
  let alerts = 0;
  await reconcileJob({
    provider: { queryBill: async () => [{ tradeNo: "T1", amountCents: 999, status: "paid" }] },
    alertHook: () => { alerts++; },
  });
  expect(alerts).toBeGreaterThan(0);                          // 触发了告警
});
```

- [ ] **Step 3: startup 接线**

在 App 启动处（spec303 的 cron 初始化旁）调 `registerReconcileCron({ provider: getPaymentProvider() })` 与 `registerCreditExpireCron()`。provider 须是实现了 `queryBill`/`refund` 的 spec304 实例（若 spec304 provider 未实现 `queryBill`，本 spec 在 spec304 接口上补该方法，或在 startup 用适配器包装）。

```typescript
// apps/api/src/index.ts（或 cron 聚合 registerAllCrons()）
import { registerReconcileCron } from "./cron/reconcile-job";
import { registerCreditExpireCron } from "./cron/credit-expire-job";
import { getPaymentProvider } from "./services/payment-provider";

export function registerBillingCrons() {
  registerReconcileCron({ provider: getPaymentProvider() });
  registerCreditExpireCron();
}
```

- [ ] **Step 4: 全量通过 + 合并**

```bash
cd apps/api && bun test
git add apps/api/src/cron/reconcile-job.ts apps/api/src/index.ts apps/api/test/reconcile.test.ts
git commit -m "feat(spec306): 对账 Cron 注册 + startup 接线(registerBillingCrons)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout main && git merge --no-ff phase3/spec306-reconcile-refund-expire -m "merge spec306: 对账 + 退款 + 积分过期"
git push origin main
```

---

## 验收清单（spec306）

**对账（§6.3）**
- [ ] `reconcile_diffs` 表建好；`runReconcile(date, {provider})` 逐笔比对账单 vs `payment_orders`。
- [ ] 检出 4 类差异：金额不符 `amount_mismatch`、状态不符 `status_mismatch`、账单单边 `bill_only`、本地单边 `local_only`，落表 + 触发 `alertHook`。
- [ ] 对账只读不改账；同 `(billDate, tradeNo, diffType)` 幂等不重复落，可重复跑。
- [ ] `auditLedger` 校验 `credit_balances` vs `Σ credit_transactions`，不一致落 `ledger_mismatch` + 告警。
- [ ] `registerReconcileCron` 经 spec303 `registerCron("reconcile", 1天)` 注册（Redis 分布式单例）。

**退款（§6.2(D)）**
- [ ] `POST /api/admin/refunds {orderId, amount, reason}` 带 operator；非法（订单非 paid/超额）拒绝。
- [ ] 流转 `refunds` pending → `provider.refund` → done + `payment_orders` refunded；失败 → failed（订单/积分/协议不变）。
- [ ] 成功时按比例**扣回已发积分**（负向流水，`idempotencyKey=refund:<id>` 幂等）；关联协议则**解约 unsigned**。
- [ ] 退款幂等键 `out_request_no=refundId`；敏感操作留 operator + 审计（`TODO(spec309)` 接 `admin_audit_logs`）。

**积分过期（§5.1）**
- [ ] `registerCreditExpireCron` 经 spec303 `registerCron("credit_expire", 1天)` 注册。
- [ ] `expireCreditsJob` 调 `credits.expireDue(now)`，到期批次写 `expire` 流水（FIFO + 幂等由 spec302 保证）。

**通用**
- [ ] job 体单独导出、可直调测试（mock provider，不依赖 Redis/定时器）。
- [ ] `bun test` 全绿；迁移可重复跑；单文件不超 1000 行。
```