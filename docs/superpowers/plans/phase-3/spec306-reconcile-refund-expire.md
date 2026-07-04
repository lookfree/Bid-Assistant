# spec306 · 对账 + 退款 + 积分过期 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Phase 3 商业化的「资金校验与回退」三件套（架构 §6.3 对账 / §6.2(D) 退款 / §5.1 积分过期）：
1. **每日对账 Cron**——按 `payment_orders` 逐笔调收钱吧「查询」接口核对终态（重点清算 `unknown` 态订单），比对金额/状态，差异落 `reconcile_diffs` + 告警；积分账本独立审计（余额 = Σ流水）。（如后续开通收钱吧对账单导出，再以账单文件比对替代逐笔查询，接口不变。）
2. **退款流程**——`createRefund` service（建 `refunds(pending)` → `provider.refund` → 成功置 `done` + 订单 `refunded` + 必要时扣回已发积分（负向 `refund_clawback` 流水）；失败 `failed`；敏感操作留审计）。**退款唯一入口收口到 spec310 `POST /admin-api/refunds`（过 admin RBAC + 审计），本 spec 不建自有路由，只产出 `createRefund` 供 spec310 调用。**
3. **积分过期 Cron**——调 `credits.expireDue(now)` 写 `expire` 流水。

本 spec **只消费** spec302 账本、spec303 Cron、spec304 支付抽象，不重复实现它们；新增对账逻辑、退款编排、过期任务注册。

**Architecture:**
- **对账**：每日 `registerCron("reconcile", 1 天)` 调对账 job 体。job 扫当日（含 `unknown` 态存量）`payment_orders`，逐笔 `provider.query(clientSn)` 取收钱吧终态（`{sn, tradeNo, amountCents, status}`），比对**金额**与**状态**；差异（金额不符/状态不符/查无此单/本地 unknown 而通道已付）写入 **`reconcile_diffs` 表**并触发**告警钩子**（`alertHook`，默认 console.error，可注入）。积分账本独立审计：抽样/全量校验 `credit_balances.balance === Σ credit_transactions.amount`，不一致也落 diff。**对账只读不改账**（差异交由人工/退款流程处置），保证幂等可重复跑。
- **退款**：本 spec 只产出 `createRefund(input, deps)` **service**（不建路由）。**退款唯一入口收口到 spec310 `POST /admin-api/refunds`（过 admin RBAC + 审计），由 spec310 取 admin 会话的 `operator` 传入并调用本 service。** 流程：①事务内建 `refunds(pending)` 并校验订单为 `paid`、退款额 ≤ 订单额；②调 `provider.refund({clientSn, refundSn, amountCents})`（refundSn=refunds.id，通道侧幂等）；③成功 → `refunds.status=done` + `payment_orders.status=refunded` + （若该订单曾入账积分）写**负向 `refund_clawback` 积分流水**扣回；④失败 → `refunds.status=failed`。整个动作走**审计**（operator + 前后值）：service 内把 `operator` 落 `refunds` + 占位 audit；正式审计装置在 spec310 入口侧（admin RBAC + 审计）落地。
- **过期**：每日 `registerCron("credit_expire", 1 天)` 调 `credits.expireDue(now)`（spec302 已实现 FIFO 先过期先扣 + `expire:<grantId>` 幂等），写 `expire` 流水。Cron 体只是薄封装 + 日志。

**Tech Stack:** Hono 4.12、Bun、Drizzle ORM、PostgreSQL（事务）、Zod、Redis（Cron 锁，经 spec303）、bun:test。

## Global Constraints

见 `spec300-index.md`。本 spec 关键：
- **钱只在 App API 动**；对账是只读校验，不改账；退款是唯一会"扣回积分"的运营动作，必须事务 + 审计。
- **余额 = Σ流水**：积分账本审计 = 校验 `credit_balances` 缓存与 `Σ credit_transactions` 一致。
- 周期任务（对账/过期）统一走 **Redis 分布式单例 Cron**（spec303 `registerCron(name, everyMs, jobFn, opts?) -> {stop}` / `withCronLock<T>(name, fn) -> Promise<T|undefined>`），不引入独立调度器；job 体幂等、可重复跑。
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
│   └── refunds.ts                # 新：退款编排（建单→provider.refund→落账/扣积分/审计）
└── cron/
    ├── reconcile-job.ts          # 新：registerCron("reconcile", 1天) 注册
    └── credit-expire-job.ts      # 新：registerCron("credit_expire", 1天) → credits.expireDue
# 注：本 spec 不建退款路由。退款唯一入口收口到 spec310 POST /admin-api/refunds（过 admin RBAC + 审计），spec310 调用本 spec 的 createRefund service。
apps/api/test/
├── reconcile.test.ts             # 新：金额/状态差异检出 + 单边账 + 账本审计
├── refunds.test.ts               # 新：pending→done + 订单 refunded + 扣回积分 + 失败 failed
└── credit-expire-job.test.ts     # 新：过期 job 调 expireDue 写 expire
```

> 文件按职责拆分，单文件不超 1000 行（用户全局约束）；Cron 注册与 job 体分离，便于测试直接调 job 体。

---

## Interfaces

**消费（来自前序 spec，不在本 spec 实现）：**
- spec303 Cron（契约以 spec303 为准）：`registerCron(name: string, everyMs: number, jobFn: () => Promise<void>, opts?): { stop: () => Promise<void> }`（注册时立即首跑一次 tick，重复触发由业务幂等键去重；stop 返回在途 tick 的 drain Promise，停机须 await 后再 closeRedis）；`withCronLock<T>(name: string, fn: () => Promise<T>): Promise<T | undefined>`（`registerCron` 内部已用 `withCronLock` 包裹保证分布式单例，未抢到锁时跳过；本 spec 直接用 `registerCron`，拿到的 `{ stop }` 句柄用于关停，job 体单独导出供测试直调）。
- spec302 账本：`credits.expireDue(now: Date) -> Promise<number>`；`credits.grant(userId, amount, opts)`（退款扣回积分用负向 amount，`type: "refund_clawback"`，spec301 已登记；**不借 spec302 的 `release`**——`release` 是 hold 退还净 0 语义，见 Task 2）。
- spec304 支付：`PaymentProvider` 接口（含 `query`/`refund`）。本 spec **不另起一套** provider 接口，直接复用 spec304 的类型：
  - `query(clientSn: string) -> Promise<PaymentResult>`（spec304 定义，字段 `totalAmountCents?: number` 为通道实付金额（分），对账用它做金额核对）。对账侧用 `Pick<PaymentProvider, "query">` 收窄，不自建 provider 接口。**收钱吧无账单拉取 API（以官方文档为准）——对账采用"逐笔查询核对"**；如后续开通商户后台对账单导出，再加可选的账单文件比对路径，`runReconcile` 签名不变。
  - `refund(opts: { clientSn: string; refundSn: string; amountCents: number }) -> Promise<{ ok: boolean }>`（spec304 实契约；refundSn 幂等）。
- 表（spec301）：`paymentOrders`（含 `clientSn/providerTradeNo/status(created/paid/failed/unknown/refunded)`）、`refunds`、`creditTransactions`、`creditBalances`。（无 `paymentAgreements`——不做自动续费）

**产出（已按实现+review 定稿，本节即真实契约）：**
- `reconcileDiffs` 表：diff_type ∈ {amount_mismatch, status_mismatch, unknown_paid, provider_missing, ledger_mismatch, orphan_hold, refund_stuck}；`subject` 列为去重主体（订单类=tradeNo、账本类=userId、孤儿=holdId、退款类=refundId），部分唯一索引 (diff_type, subject) WHERE resolved='open'——同问题只保留一行 open，人工 resolve 后再次检出才开新行。
- `runReconcile(date, { provider, alertHook? }) -> { checked, diffs }`：扫 [date−7天, date+1天) 已结算单（7 天=可支付窗，晚结算单不漏）+ 全量存量 unknown；本地 refunded 也核对通道退款态；unknown 满 24h 且通道明确失败才收敛 failed（迟到 PAID 留门）。
- `auditLedger(date?, alertHook?)`：余额 vs Σ流水双向核对，候选复查后落 diff（防在途交易假告警）。
- `releaseOrphanHolds(now?, { maxAgeMs?, alertHook? })`：spec302 C1——>24h 无了结 hold 自动 release + orphan_hold 留痕（release 真插入才计）。
- `scanStuckRefunds(now?, { maxAgeMs?, alertHook? })`：pending 超 1h 的退款单落 refund_stuck 转人工（**不自动重试**——换 refundSn 重试是通道双退路径）。
- `createRefund({ orderId, amountCents, reason, operator, allowNegativeBalance? }, { provider }) -> { refundId, status: "done"|"failed"|"pending" }`：**pending=通道结果不明**（网络异常，占累计额度挡重试，待人工）；部分退款订单留 paid、退满才 refunded；扣回按累计比例；扣回超余额需 allowNegativeBalance。仅 spec310 `POST /admin-api/refunds` 调用。
- Cron（`crons/billing.ts`，spec303 CronJob 工厂风格，startCronRunner 注册）：`creditExpireCronJob()` 与 `ledgerAuditCronJob({alertHook?})`（审计+孤儿+卡死退款，三段隔离）**始终注册**；`reconcileCronJob({provider, alertHook?})` 走 getPayment gate。job 体 `expireCreditsJob/ledgerAuditJob/reconcileJob` 均可直调测试。
- unknown_paid 修复：spec310 人工确认后调 `markPaid(orderId, info, { allowStale: true })` 幂等补入账。

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
  // amount_mismatch(金额不符) | status_mismatch(状态不符) | unknown_paid(本地未知而通道已付★最高优先) | provider_missing(本地已结算而通道查无) | ledger_mismatch(账本余额≠Σ流水)
  diffType: text("diff_type").notNull(),
  tradeNo: text("trade_no"),                                   // 关联收钱吧 sn / 渠道 trade_no（账本审计类为空）
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

// mock provider：按 clientSn 返回可控查询结果
function mockProvider(results: Record<string, { status: string; amountCents?: number; sn?: string }>) {
  return { query: async (clientSn: string) => results[clientSn] ?? { status: "failed" } } as any;
}

test("金额不符 → 落 amount_mismatch", async () => {
  const userId = await makeTestUser();
  const [order] = await db.insert(paymentOrders).values({
    userId, type: "recharge", amountCents: 1000, status: "paid",
    provider: "shouqianba", providerTradeNo: "T1", idempotencyKey: "o1",
  }).returning();
  // 通道查询金额 999，本地 1000 → 金额不符
  const res = await runReconcile("2026-06-29", {
    provider: mockProvider({ [order.clientSn]: { status: "paid", amountCents: 999, sn: "T1" } }),
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
    provider: "shouqianba", providerTradeNo: "T2", idempotencyKey: "o2",
  });
  const res = await runReconcile("2026-06-29", {
    provider: mockProvider([{ tradeNo: "T2", amountCents: 500, status: "refunded" }]),
  });
  expect(res.diffs).toBe(1);
  const [d] = await db.select().from(reconcileDiffs).where(eq(reconcileDiffs.tradeNo, "T2"));
  expect(d.diffType).toBe("status_mismatch");
});

test("unknown 清算：通道已付 → unknown_paid 差异；通道明确失败 → 订单收敛 failed", async () => {
  const userId = await makeTestUser();
  const [oPaid] = await db.insert(paymentOrders).values({
    userId, type: "recharge", amountCents: 300, status: "unknown",
    provider: "shouqianba", clientSn: "C_UP", idempotencyKey: "o3",
  }).returning();
  const [oFail] = await db.insert(paymentOrders).values({
    userId, type: "recharge", amountCents: 400, status: "unknown",
    provider: "shouqianba", clientSn: "C_UF", idempotencyKey: "o3b",
  }).returning();
  const res = await runReconcile("2026-06-29", {
    provider: mockProvider({ C_UP: { status: "paid", amountCents: 300, sn: "S1" }, C_UF: { status: "failed" } }),
  });
  expect(res.diffs).toBe(1);                                   // unknown_paid 落差异
  const rows = await db.select().from(reconcileDiffs);
  expect(rows.map((r) => r.diffType)).toContain("unknown_paid");
  const [f] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, oFail.id));
  expect(f.status).toBe("failed");                             // 通道明确失败 → 收敛
});

test("本地已结算而通道查无 → provider_missing", async () => {
  const userId = await makeTestUser();
  await db.insert(paymentOrders).values({
    userId, type: "recharge", amountCents: 300, status: "paid",
    provider: "shouqianba", clientSn: "C_LOCAL", providerTradeNo: "T_LOCAL", idempotencyKey: "o3c",
  });
  const res = await runReconcile("2026-06-29", { provider: mockProvider({}) });
  expect(res.diffs).toBe(1);
  const rows = await db.select().from(reconcileDiffs);
  expect(rows.map((r) => r.diffType)).toContain("provider_missing");
});

test("对账一致 → 无差异；可重复跑（幂等不重复落 diff）", async () => {
  const userId = await makeTestUser();
  await db.insert(paymentOrders).values({
    userId, type: "recharge", amountCents: 800, status: "paid",
    provider: "shouqianba", providerTradeNo: "T_OK", idempotencyKey: "o4",
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
- `runReconcile(date, deps)`：扫**当日窗口 `[date 00:00, 次日 00:00)`** 的 `payment_orders`（按 `created_at` 过滤，不取全表）**加上全部存量 `unknown` 态订单**（不限当日——unknown 必须清算到终态为止），逐笔 `deps.provider.query(order.clientSn)` 取通道终态。
- 比对口径（集中定义，注释写清）：
  - 本地 `paid`：通道非 `paid` → `status_mismatch`；金额不符 → `amount_mismatch`。
  - 本地 `unknown`：通道 `paid` → `unknown_paid`（钱已收、账没入——最高优先级差异，人工/自动补入账走幂等 markPaid）；通道 `failed` → 订单可安全置 `failed`（对账唯一允许的写动作，条件 UPDATE `WHERE status='unknown'`）。
  - 本地 `paid/refunded` 而通道查无此单 → `provider_missing`。
  - 本地 `created/failed` 不参与比对。
- **幂等**：落 diff 前先查同 `(billDate, clientSn, diffType)` 是否已存在 `open`，存在则跳过（重复跑不重复落）。
- 返回 `{ checked, diffs }`。

```typescript
import { db } from "../db";
import { paymentOrders } from "../db/schema/payments";
import { reconcileDiffs } from "../db/schema/reconcile";
import { creditTransactions, creditBalances } from "../db/schema/credits";
import { and, eq, gte, lt, sql } from "drizzle-orm";
// 复用 spec304 的支付抽象类型，不自建 provider 接口
import type { PaymentProvider } from "./payment/provider";

// 对账只需要 query 这一能力 → Pick 收窄，便于 mock/注入
export type ReconcileProvider = Pick<PaymentProvider, "query">;
export type AlertHook = (msg: string, detail: unknown) => void;

const defaultAlert: AlertHook = (msg, detail) => console.error(`[reconcile] ${msg}`, detail);

async function recordDiff(d: typeof reconcileDiffs.$inferInsert, alert: AlertHook) {
  // 幂等：同 (billDate, clientSn, diffType) 已有 open 则跳过
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
  date: string,  // 对账日，YYYY-MM-DD
  deps: { provider: ReconcileProvider; alertHook?: AlertHook },
): Promise<{ checked: number; diffs: number }> {
  const alert = deps.alertHook ?? defaultAlert;
  const dayStart = new Date(`${date}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  // 当日已结算订单 + 全量存量 unknown（unknown 必须清算到终态）
  const dayOrders = await db.select().from(paymentOrders).where(and(
    gte(paymentOrders.createdAt, dayStart), lt(paymentOrders.createdAt, dayEnd),
  ));
  const unknowns = await db.select().from(paymentOrders).where(eq(paymentOrders.status, "unknown"));
  const seen = new Set<string>();
  const targets = [...dayOrders, ...unknowns]
    .filter((o) => ["paid", "refunded", "unknown"].includes(o.status))
    .filter((o) => (seen.has(o.id) ? false : (seen.add(o.id), true)));
  let diffs = 0;

  for (const o of targets) {
    const r = await deps.provider.query(o.clientSn);   // 逐笔查通道终态
    if (o.status === "unknown") {
      if (r.status === "paid") {
        if (await recordDiff({ billDate: date, diffType: "unknown_paid", tradeNo: r.sn ?? o.clientSn, orderId: o.id, localValue: "unknown", billValue: String(r.amountCents ?? "") }, alert)) diffs++;
      } else if (r.status === "failed") {
        // 对账唯一允许的写动作：unknown 且通道明确失败 → 收敛为 failed（条件 UPDATE）
        await db.update(paymentOrders).set({ status: "failed" })
          .where(and(eq(paymentOrders.id, o.id), eq(paymentOrders.status, "unknown")));
      }
      continue;
    }
    if (r.status === "pending" || (r.status === "failed" && !r.sn)) {
      if (await recordDiff({ billDate: date, diffType: "provider_missing", tradeNo: o.providerTradeNo ?? o.clientSn, orderId: o.id, localValue: o.status }, alert)) diffs++;
      continue;
    }
    if (o.status === "paid" && r.status !== "paid") {
      if (await recordDiff({ billDate: date, diffType: "status_mismatch", tradeNo: o.providerTradeNo ?? o.clientSn, orderId: o.id, localValue: o.status, billValue: r.status }, alert)) diffs++;
    }
    if (r.amountCents != null && r.amountCents !== o.amountCents) {
      if (await recordDiff({ billDate: date, diffType: "amount_mismatch", tradeNo: o.providerTradeNo ?? o.clientSn, orderId: o.id, localValue: String(o.amountCents), billValue: String(r.amountCents) }, alert)) diffs++;
    }
  }
  return { checked: targets.length, diffs };
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

## Task 2: 退款编排（建单 → provider.refund → 落账 / 扣回积分 / 审计）

**Files:** Create `apps/api/src/services/refunds.ts`、`apps/api/test/refunds.test.ts`

- [ ] **Step 1: 失败测试 `test/refunds.test.ts`（pending→done 全链路）**

```typescript
import { createRefund } from "../src/services/refunds";
import { db } from "../src/db";
import { paymentOrders, refunds } from "../src/db/schema/payments";
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
    provider: "shouqianba", providerTradeNo: "T1", idempotencyKey: "o1",
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
  // 扣回积分：写了一笔负向 refund_clawback 流水（不是 release）
  const txs = await db.select().from(creditTransactions).where(eq(creditTransactions.userId, userId));
  const negative = txs.filter((t) => t.amount < 0);
  expect(negative.length).toBe(1);
  expect(negative[0].amount).toBe(-1000);
  expect(negative[0].type).toBe("refund_clawback");
});

test("退款失败：refunds failed，订单不变，不扣积分", async () => {
  const userId = await makeTestUser();
  const [order] = await db.insert(paymentOrders).values({
    userId, type: "recharge", amountCents: 500, status: "paid",
    provider: "shouqianba", providerTradeNo: "T3", idempotencyKey: "o3",
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
    provider: "shouqianba", providerTradeNo: "T4", idempotencyKey: "o4",
  }).returning();
  await expect(createRefund(
    { orderId: order.id, amountCents: 500, reason: "x", operator: "ops" },
    { provider: okProvider() },
  )).rejects.toThrow();
});
```

- [ ] **Step 2: 写 `services/refunds.ts`（退款编排）**

要点：
- 入参 Zod 校验：`{ orderId: uuid, amountCents: int>0, reason: string, operator: string }`。
- **type=renewal 单退款须同时处置订阅周期**（spec305 后 renewal 结算会顺延 current_period_end 并可复活状态）：只回扣积分不回退周期=退钱留会员。实现时二选一并落审计：①全额退款 → 周期回退一档（current_period_end 减一周期快照、必要时状态回落）；②仅允许人工处置（service 拒绝 renewal 单自动退款，转人工）。默认取 ②（保守），运营量起来再做 ①。
- ①事务建 `refunds(pending)` + 校验：订单存在且 `status==="paid"`；`amountCents <= order.amountCents`（不满足抛错，不建 provider 调用）。
- ②`refundSn = refunds.id`（退款幂等键，同一退款重试不重复退）。调 `deps.provider.refund({ clientSn: order.clientSn, refundSn, amountCents })`（spec304 实契约：按我方订单号 client_sn 退款）。
- ③成功（`ok`）：事务内 `refunds.status=done` + `payment_orders.status=refunded` + 若该订单曾入账积分（按 `ref===order.id` 查 `purchase/grant` 正向流水之和 > 0）则写**负向流水** `type:"refund_clawback"`（spec301 已登记的新类型，负向注销充值积分；**不借 `release`**，`release` 是 spec302 的 hold 退还净 0 语义）`amount: -clawback`（`idempotencyKey: refund_clawback:${refundId}`，幂等）。
- ④失败：`refunds.status=failed`，不动订单/积分/协议。
- **审计**：成功/失败都写审计（operator + 前值后值）。spec309 审计装置就绪则调 `audit.log({ operator, action:"refund", orderId, before, after })`；未就绪先留 `operator` 字段写进 `refunds` + 顶部 `TODO(spec309): 接 admin_audit_logs 审计装置`。

```typescript
import { z } from "zod";
import { db } from "../db";
import { paymentOrders, refunds } from "../db/schema/payments";
import { creditTransactions } from "../db/schema/credits";
import { and, eq, sql } from "drizzle-orm";

// TODO(spec309): 接 admin_audit_logs 审计装置（operator + 前后值）；当前先把 operator 落 refunds + console 审计
function auditLog(entry: { operator: string; action: string; orderId: string; before: unknown; after: unknown }) {
  console.info("[audit]", entry); // spec309 就绪后替换为 admin_audit_logs 写入
}

export interface RefundProvider {
  refund(args: { clientSn: string; refundSn: string; amountCents: number }): Promise<{ ok: boolean }>; // spec304 实契约
}

const InputSchema = z.object({
  orderId: z.string().uuid(),
  amountCents: z.number().int().positive(),
  reason: z.string(),
  operator: z.string().min(1),
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
    result = await deps.provider.refund({ clientSn: order.clientSn, refundSn: refundId, amountCents: input.amountCents });
  } catch (e) {
    result = { ok: false, error: (e as Error).message };
  }

  if (!result.ok) {
    await db.update(refunds).set({ status: "failed" }).where(eq(refunds.id, refundId));
    auditLog({ operator: input.operator, action: "refund.failed", orderId: order.id, before: { orderStatus: order.status }, after: { refundStatus: "failed", error: result.error } });
    return { refundId, status: "failed" };
  }

  // ③ 成功：事务落账 + 扣回积分
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
        // refund_clawback：负向注销已入账的充值积分（spec301 已登记的类型）。
        // 注意不要用 release —— release 是 spec302 的 hold 退还（+N 净 0），语义不同。
        userId: order.userId, type: "refund_clawback", amount: -clawback, ref: order.id,
        idempotencyKey: `refund_clawback:${refundId}`,
      }).onConflictDoNothing({ target: creditTransactions.idempotencyKey });
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
git commit -m "feat(spec306): 退款编排(pending→done/failed + 订单 refunded + 扣回积分 + 审计占位)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 退款入口收口到 spec310（本 spec 不建路由）

**项目级决策：退款唯一入口收口到 spec310 `POST /admin-api/refunds`（过 admin RBAC + 审计）。** 本 spec **不建** 自有的 `POST /api/admin/refunds` 路由，只产出 `createRefund` service（Task 2）供 spec310 调用——避免出现一条绕过 admin RBAC/审计的并行退款入口。

**Files:** 无新增/修改文件（本 Task 仅为契约说明）。

- [ ] **Step 1: 确认无自建退款路由**

- 不创建 `apps/api/src/routes/admin/refunds.ts`，不在主 app 挂任何 `POST /api/admin/refunds`。
- `createRefund(input, deps)` 已在 Task 2 产出，签名 `{ orderId, amountCents, reason, operator }`；spec310 的 `POST /admin-api/refunds` handler 负责：
  - 过 admin RBAC + 鉴权（spec310/spec309 装置）；
  - 从 admin 会话取 `operator`（不再 header/body 兜底）；
  - body Zod 校验 `{ orderId, amount, reason }` 后映射为 `amountCents` 传入；
  - 注入 spec304 provider（实现 `refund`/`query`）调 `createRefund`；
  - 落审计（operator + 前后值）到 `admin_audit_logs`。
- 退款的领域逻辑（建单 / provider.refund / 落账 / `refund_clawback` 扣回）全在本 spec 的 service，spec310 只做入口编排，不重复实现。

- [ ] **Step 2: grep 自检无残留路由**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
# 应无输出：本 spec 不得引入 /api/admin/refunds 路由
! grep -rn "/api/admin/refunds" apps/api/src
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

/** 注册每日过期 Cron（Redis 分布式单例，spec303 registerCron 内部已加锁）。
 *  spec303 契约：registerCron(name, everyMs, jobFn, opts?) -> { stop: () => Promise<void> }；注册即首跑，stop 为 drain。 */
export function registerCreditExpireCron(): { stop: () => Promise<void> } {
  return registerCron("credit_expire", ONE_DAY_MS, expireCreditsJob);
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
import { runReconcile, auditLedger, type ReconcileProvider, type AlertHook } from "../services/reconcile";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** 对账 job 体：对账昨日账单 + 账本审计。可直调测试。 */
export async function reconcileJob(deps: { provider: ReconcileProvider; alertHook?: AlertHook }): Promise<void> {
  const date = new Date(Date.now() - ONE_DAY_MS).toISOString().slice(0, 10); // 对昨日账
  const r = await runReconcile(date, deps);
  await auditLedger(date, deps.alertHook);
  console.info(`[cron:reconcile] ${date} checked=${r.checked} diffs=${r.diffs}`);
}

/** 注册每日对账 Cron（Redis 分布式单例）。provider 来自 spec304（须实现 query）。
 *  spec303 契约：registerCron(name, everyMs, jobFn, opts?) -> { stop: () => Promise<void> }；注册即首跑，stop 为 drain。 */
export function registerReconcileCron(deps: { provider: ReconcileProvider; alertHook?: AlertHook }): { stop: () => Promise<void> } {
  return registerCron("reconcile", ONE_DAY_MS, () => reconcileJob(deps));
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
    provider: { query: async () => ({ status: "paid", amountCents: 999, sn: "T1" }) },
    alertHook: () => { alerts++; },
  });
  expect(alerts).toBeGreaterThan(0);                          // 触发了告警
});
```

- [ ] **Step 3: startup 接线**

在 App 启动处并入 spec304 已有的 `const payment = getPayment()` 装配（`services/payment`，凭据不齐返回 undefined 整体跳过——不得绕过该 gate 半开）：payment 存在才注册 `registerReconcileCron({ provider: payment.provider })`；`registerCreditExpireCron()` 不依赖 provider，独立注册。

```typescript
// apps/api/src/index.ts（或 cron 聚合 registerAllCrons()）
import { registerReconcileCron } from "./cron/reconcile-job";
import { registerCreditExpireCron } from "./cron/credit-expire-job";
import { getPayment } from "./services/payment"; // spec304 唯一装配点

export function registerBillingCrons() {
  const payment = getPayment();
  if (payment) registerReconcileCron({ provider: payment.provider }); // 凭据不齐整体跳过，不半开
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
- [ ] 检出 4 类差异：金额不符 `amount_mismatch`、状态不符 `status_mismatch`、未知已付 `unknown_paid`（★最高优先）、通道查无 `provider_missing`，落表 + 触发 `alertHook`；unknown 且通道明确失败 → 订单收敛 `failed`（对账唯一写动作）。
- [ ] 对账只读不改账；同 `(billDate, tradeNo, diffType)` 幂等不重复落，可重复跑。
- [ ] `auditLedger` 校验 `credit_balances` vs `Σ credit_transactions`，不一致落 `ledger_mismatch` + 告警。
- [ ] `registerReconcileCron` 经 spec303 `registerCron("reconcile", 1天)` 注册（Redis 分布式单例）。

**退款（§6.2(D)）**
- [ ] `createRefund({orderId, amountCents, reason, operator})` service 产出，供 spec310 `POST /admin-api/refunds` 调用；本 spec **不建** 自有 `/api/admin/refunds` 路由；非法（订单非 paid/超额）拒绝。
- [ ] 流转 `refunds` pending → `provider.refund` → done + `payment_orders` refunded；失败 → failed（订单/积分/协议不变）。
- [ ] 成功时按比例**扣回已发积分**（负向流水 `type:"refund_clawback"`，`idempotencyKey=refund_clawback:<id>` 幂等；不借 `release`）。
- [ ] 退款幂等键 `out_request_no=refundId`；敏感操作 service 内留 operator + 占位 audit；正式审计（`admin_audit_logs`）在 spec310 退款入口侧（admin RBAC）落地。

**积分过期（§5.1）**
- [ ] `registerCreditExpireCron` 经 spec303 `registerCron("credit_expire", 1天)` 注册。
- [ ] `expireCreditsJob` 调 `credits.expireDue(now)`，到期批次写 `expire` 流水（FIFO + 幂等由 spec302 保证）。

**通用**
- [ ] job 体单独导出、可直调测试（mock provider，不依赖 Redis/定时器）。
- [ ] `bun test` 全绿；迁移可重复跑；单文件不超 1000 行。
```