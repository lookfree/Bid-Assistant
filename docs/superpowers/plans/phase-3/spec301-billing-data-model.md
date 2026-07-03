# spec301 · 计费数据模型 + 配置化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建 Phase 3 计费/会员/订阅/支付/推荐的**全部数据表**（9 张，public schema，Drizzle）+ **`billing_configs` 配置表** + **种子配置加载器**（占位定价，运营后台 spec310 接管同一批配置）。字段以《支付与计费系统 · 开发需求规格》第四节为准。本 spec 只建表 + 配置读写，不含业务逻辑（账本引擎在 spec302、支付在 spec304…）。

**Architecture:** 全部表落 `public` schema（与 Phase 0 的 `users` 同库），Drizzle 定义 + 迁移。`billing_configs` 是单一权威键值表（`key` 唯一、`value` JSONB）；`config` 服务提供 `getConfig(key)`/`getConfigs()` 读 + 种子写入；种子文件给占位值（**非真实定价**），spec310 后台 UI 写同一张表。金额用 `numeric`（分为单位或元带精度，统一约定），积分用 `integer`。

**Tech Stack:** Hono、Drizzle ORM、PostgreSQL、Zod、bun:test。

## Global Constraints

见 `spec300-index.md`。本 spec 关键：
- 字段对齐规格文档第四节；数值字段**留空/占位**，由 `billing_configs` + 种子注入，不写死真实定价。
- 只建表 + 配置读写；账本/支付/续费逻辑在后续 spec。
- 金额单位全局统一（本 spec 用**分**存储，`amount_cents: integer`，避免浮点）；积分 `integer`。
- TDD（bun test）；`main` 上先开分支。

---

## File Structure

```
apps/api/src/
├── db/schema/
│   ├── plans.ts                 # 新：plans / subscriptions
│   ├── credits.ts               # 新：credit_transactions / credit_balances
│   ├── payments.ts              # 新：payment_orders / payment_terminals / refunds
│   └── billing.ts               # 新：referrals / billing_configs
├── services/config.ts           # 新：getConfig/getConfigs + 种子写入
└── config/billing-seed.ts       # 新：种子配置（占位定价，非真实）
apps/api/drizzle/                 # 迁移（drizzle-kit generate）
apps/api/test/
├── billing-schema.test.ts       # 新：建表往返 + 约束（唯一/枚举/外键）
└── config-seed.test.ts          # 新：种子写入 + getConfig 读取
```

---

## Interfaces（本 spec 对外产出，供 spec302–310 依赖）

- Produces：
  - 表对象：`plans`、`subscriptions`、`creditTransactions`、`creditBalances`、`paymentOrders`、`paymentAgreements`、`refunds`、`referrals`、`billingConfigs`。
  - `getConfig(key: string) -> Promise<unknown>`、`getConfigs(prefix?: string) -> Promise<Record<string, unknown>>`、`setConfig(key: string, value: unknown) -> Promise<void>`（运营后台 spec310 改配置用，upsert 即生效）、`seedConfigs() -> Promise<void>`。
  - 种子键约定（`billing_configs.key`）：`credit_cost.<op>`（操作积分口径）、`recharge_packs`（充值包）、`credit_rate`（汇率）、`grant_expire_days`/`reward_expire_days`、`referral_rules`、`deduct_retry`。

---

## Task 1: 会员表（plans / subscriptions）

**Files:** Create `apps/api/src/db/schema/plans.ts`、迁移、`apps/api/test/billing-schema.test.ts`（先建空壳）

- [ ] **Step 1: 开分支**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout -b phase3/spec301-billing-data-model
```

- [ ] **Step 2: 写 `db/schema/plans.ts`**

```typescript
import { pgTable, uuid, text, integer, jsonb, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./users";

// 套餐：所有数值由配置/后台注入（price_cents/grant 等留默认 0）
export const plans = pgTable("plans", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  priceCents: integer("price_cents").notNull().default(0),      // 价格（分）
  currency: text("currency").notNull().default("CNY"),
  billingCycle: text("billing_cycle").notNull(),               // month/quarter/year（周期）
  grantCreditsPerCycle: integer("grant_credits_per_cycle").notNull().default(0),
  features: jsonb("features").$type<Record<string, unknown>>().default({}),  // 权益开关
  limits: jsonb("limits").$type<Record<string, unknown>>().default({}),      // 并发/项目数上限
  status: text("status").notNull().default("active"),          // active(上架)/archived(下架)
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  planId: uuid("plan_id").notNull().references(() => plans.id),
  status: text("status").notNull().default("active"),          // active/past_due/expired
  currentPeriodStart: timestamp("current_period_start"),
  currentPeriodEnd: timestamp("current_period_end"),
  createdAt: timestamp("created_at").defaultNow().notNull(),   // 无 auto_renew/agreement_no：不做自动续费（架构 §6.2）
}, (t) => ({ userIdx: index("subscriptions_user_idx").on(t.userId) }));
```

- [ ] **Step 3: 生成迁移 + 空壳测试 + 跑通**

```bash
cd apps/api && bun run drizzle-kit generate
```
`test/billing-schema.test.ts`：先放 `test("placeholder", () => expect(true).toBe(true))`，确认迁移可跑、表创建。

- [ ] **Step 4: 提交**

```bash
git add apps/api/src/db/schema/plans.ts apps/api/drizzle apps/api/test/billing-schema.test.ts
git commit -m "feat(spec301): plans/subscriptions 表

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 积分账本表（credit_transactions / credit_balances）

**Files:** Create `apps/api/src/db/schema/credits.ts`、迁移；Modify `test/billing-schema.test.ts`

- [ ] **Step 1: 写 `db/schema/credits.ts`**

```typescript
import { pgTable, uuid, text, integer, timestamp, index, unique } from "drizzle-orm/pg-core";
import { users } from "./users";

// 只追加事件账本：余额 = Σ amount（balance 仅缓存，见 credit_balances）
export const creditTransactions = pgTable("credit_transactions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  // grant(赠送) | purchase(充值) | hold(预扣) | settle(结算) | release(退还) | expire(过期) | referral_reward(推荐奖励) | refund_clawback(退款注销已入账积分，负向)
  type: text("type").notNull(),
  amount: integer("amount").notNull(),                         // ± 积分
  sourceBatch: text("source_batch"),                          // 来源批次（FIFO 过期用）
  expireAt: timestamp("expire_at"),                           // 该笔过期时间（充值/赠送有别）
  ref: text("ref"),                                           // 关联 agent_run / order / referral
  idempotencyKey: text("idempotency_key").notNull(),         // 幂等键必填（nullable+unique 被多 NULL 绕过）
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  userIdx: index("credit_tx_user_idx").on(t.userId),
  idemUq: unique("credit_tx_idem_uq").on(t.idempotencyKey),   // 幂等：同键只入一次
}));

// 余额缓存（权威仍是 Σ流水；用于快速读 + 对账）
export const creditBalances = pgTable("credit_balances", {
  userId: uuid("user_id").primaryKey().references(() => users.id),
  balance: integer("balance").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
```

- [ ] **Step 2: 失败测试（在 billing-schema.test.ts 加）**

```typescript
import { db } from "../src/db";
import { creditTransactions } from "../src/db/schema/credits";
import { eq } from "drizzle-orm";

test("credit_transactions 幂等键唯一 + 追加", async () => {
  const userId = await makeTestUser();                        // 测试夹具：建一个 user 返回 id
  await db.insert(creditTransactions).values({ userId, type: "grant", amount: 100, idempotencyKey: "k1" });
  // 同幂等键二次插入应冲突
  await expect(
    db.insert(creditTransactions).values({ userId, type: "grant", amount: 100, idempotencyKey: "k1" })
  ).rejects.toThrow();
  const rows = await db.select().from(creditTransactions).where(eq(creditTransactions.userId, userId));
  expect(rows).toHaveLength(1);
});
```

- [ ] **Step 3: 迁移 + 通过 + 提交**

```bash
cd apps/api && bun run drizzle-kit generate && bun test test/billing-schema.test.ts
git add apps/api/src/db/schema/credits.ts apps/api/drizzle apps/api/test/billing-schema.test.ts
git commit -m "feat(spec301): credit_transactions(append-only+幂等) / credit_balances

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 支付表（payment_orders / payment_terminals / refunds）

**Files:** Create `apps/api/src/db/schema/payments.ts`、迁移；Modify 测试

- [ ] **Step 1: 写 `db/schema/payments.ts`**

```typescript
import { pgTable, uuid, text, integer, timestamp, index, unique } from "drizzle-orm/pg-core";
import { users } from "./users";

export const paymentOrders = pgTable("payment_orders", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  type: text("type").notNull(),                               // recharge/purchase/renewal
  amountCents: integer("amount_cents").notNull(),
  status: text("status").notNull().default("created"),        // created/paid/failed/unknown/refunded
  provider: text("provider").notNull().default("shouqianba"),
  clientSn: text("client_sn").notNull().unique(),             // 我方订单号（送收钱吧，全局唯一）
  providerTradeNo: text("provider_trade_no"),                 // 收钱吧订单号 sn
  channelTradeNo: text("channel_trade_no"),                   // 微信/支付宝渠道单号 trade_no
  payway: text("payway"),                                     // 实际付款方式（对账用）
  idempotencyKey: text("idempotency_key"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  userIdx: index("payment_orders_user_idx").on(t.userId),
  idemUq: unique("payment_orders_idem_uq").on(t.idempotencyKey),
}));

// 收钱吧交易终端凭证：激活产生、每日签到轮换 terminal_key（架构 §6.0）。
// 集群共享唯一真相；terminal_key 加密存储；密钥丢失只能重激活。
export const paymentTerminals = pgTable("payment_terminals", {
  id: uuid("id").defaultRandom().primaryKey(),
  terminalSn: text("terminal_sn").notNull().unique(),
  terminalKey: text("terminal_key").notNull(),                // 加密存储（Bun crypto AES，密钥走 env）
  deviceId: text("device_id").notNull().unique(),             // 激活时自定义设备号（带业务含义）
  activatedAt: timestamp("activated_at").defaultNow().notNull(),
  lastCheckinAt: timestamp("last_checkin_at"),                // 每日签到成功后更新
});

export const refunds = pgTable("refunds", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderId: uuid("order_id").notNull().references(() => paymentOrders.id),
  amountCents: integer("amount_cents").notNull(),
  reason: text("reason"),
  status: text("status").notNull().default("pending"),        // pending/done/failed
  operator: text("operator"),                                 // 运营操作人（admin）
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

- [ ] **Step 2: 失败测试**（payment_orders 幂等键唯一；refunds 外键到 order）→ 断言。

- [ ] **Step 3: 迁移 + 通过 + 提交**

```bash
cd apps/api && bun run drizzle-kit generate && bun test test/billing-schema.test.ts
git add apps/api/src/db/schema/payments.ts apps/api/drizzle apps/api/test/billing-schema.test.ts
git commit -m "feat(spec301): payment_orders/payment_terminals/refunds 表

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 推荐 + 配置表（referrals / billing_configs）

**Files:** Create `apps/api/src/db/schema/billing.ts`、迁移；Modify 测试

- [ ] **Step 1: 写 `db/schema/billing.ts`**

```typescript
import { pgTable, uuid, text, jsonb, timestamp, index, unique } from "drizzle-orm/pg-core";
import { users } from "./users";

export const referrals = pgTable("referrals", {
  id: uuid("id").defaultRandom().primaryKey(),
  inviterId: uuid("inviter_id").notNull().references(() => users.id),
  inviteeId: uuid("invitee_id").references(() => users.id),    // 注册即建关系
  code: text("code").notNull(),                               // 邀请码（绑邀请人）
  status: text("status").notNull().default("pending"),        // pending/bound/frozen（frozen=风控冻结）
  rewardState: text("reward_state").notNull().default("pending"), // pending/unlocked/capped
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  inviterIdx: index("referrals_inviter_idx").on(t.inviterId),
  inviteeUq: unique("referrals_invitee_uq").on(t.inviteeId),  // 一个被邀请人只属一个邀请关系
}));

// 单一权威键值配置表（运营注入；开发只读 + 种子写）
export const billingConfigs = pgTable("billing_configs", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
```

- [ ] **Step 2: 失败测试**（referrals invitee 唯一；billing_configs key 主键 upsert）→ 断言。

- [ ] **Step 3: 迁移 + 通过 + 提交**

```bash
cd apps/api && bun run drizzle-kit generate && bun test test/billing-schema.test.ts
git add apps/api/src/db/schema/billing.ts apps/api/drizzle apps/api/test/billing-schema.test.ts
git commit -m "feat(spec301): referrals/billing_configs 表

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 种子配置加载器（config 服务 + 占位定价）

**Files:** Create `apps/api/src/services/config.ts`、`apps/api/src/config/billing-seed.ts`、`apps/api/test/config-seed.test.ts`

- [ ] **Step 1: 写 `config/billing-seed.ts`（占位值，非真实定价）**

```typescript
// 联调占位配置（非真实定价）；spec310 后台 UI 接管写同一张 billing_configs
export const BILLING_SEED: Record<string, unknown> = {
  // 各操作积分口径（占位统一 10；真实口径见 PRD 4.4）
  "credit_cost.read": 10, "credit_cost.outline": 10, "credit_cost.content": 10,
  "credit_cost.review": 10, "credit_cost.present": 10, "credit_cost.export": 10,
  // 充值包（金额分 → 到账积分）；每项带稳定 id；充值到账以 pack.credits 为准（含赠送），credit_rate 仅用于无包任意金额充值
  "recharge_packs": [{ id: "pack_100", amountCents: 100, credits: 100 }, { id: "pack_1000", amountCents: 1000, credits: 1100 }],
  "credit_rate": { credits_per_cny_cent: 1 },                 // 正向汇率：credits = floor(amountCents × credits_per_cny_cent)（对齐 spec304，占位 1 分=1 积分）
  "grant_expire_days": 30, "reward_expire_days": 30,          // 赠送/奖励积分有效期
  "referral_rules": { inviterReward: 50, inviteeReward: 50, unlockOn: "invitee_first_paid", capPerUser: 500, riskMaxPerIpPerHour: 20 },  // riskMaxPerIpPerHour 占位，spec307 风控阈值不写死
  "renewal_reminder_days": [7, 3, 1],                          // 到期提醒天数档（T-7/T-3/T-1）
  "renewal_grace_days": 3,                                     // past_due 宽限期（天）
  "payment_poll": { windowMinutes: 6, fastSeconds: 3, slowSeconds: 10 },  // 收钱吧结果轮询窗口
};
```

- [ ] **Step 2: 写 `services/config.ts`**

```typescript
import { db } from "../db";
import { billingConfigs } from "../db/schema/billing";
import { eq } from "drizzle-orm";
import { BILLING_SEED } from "../config/billing-seed";

export async function getConfig<T = unknown>(key: string): Promise<T | undefined> {
  const [row] = await db.select().from(billingConfigs).where(eq(billingConfigs.key, key));
  return row?.value as T | undefined;
}

export async function getConfigs(prefix?: string): Promise<Record<string, unknown>> {
  const rows = await db.select().from(billingConfigs);
  const out: Record<string, unknown> = {};
  for (const r of rows) if (!prefix || r.key.startsWith(prefix)) out[r.key] = r.value;
  return out;
}

// 种子：仅写不存在的 key（不覆盖运营已改的值）
export async function seedConfigs(): Promise<void> {
  for (const [key, value] of Object.entries(BILLING_SEED)) {
    await db.insert(billingConfigs).values({ key, value })
      .onConflictDoNothing({ target: billingConfigs.key });
  }
}

// 运营改配置（spec310 后台用）：upsert 同一张表，改值即生效
export async function setConfig(key: string, value: unknown): Promise<void> {
  await db.insert(billingConfigs).values({ key, value })
    .onConflictDoUpdate({ target: billingConfigs.key, set: { value, updatedAt: new Date() } });
}
```

- [ ] **Step 3: 失败测试 `test/config-seed.test.ts`**

```typescript
import { seedConfigs, getConfig } from "../src/services/config";

test("种子写入后可读操作积分口径与推荐规则", async () => {
  await seedConfigs();
  expect(await getConfig<number>("credit_cost.read")).toBe(10);
  const rules = await getConfig<{ capPerUser: number }>("referral_rules");
  expect(rules?.capPerUser).toBe(500);
});

test("seedConfigs 不覆盖已存在的 key", async () => {
  const { db } = await import("../src/db");
  const { billingConfigs } = await import("../src/db/schema/billing");
  await db.insert(billingConfigs).values({ key: "credit_cost.read", value: 999 })
    .onConflictDoUpdate({ target: billingConfigs.key, set: { value: 999 } });
  await seedConfigs();                                        // 不应把 999 改回 10
  expect(await getConfig<number>("credit_cost.read")).toBe(999);
});
```

- [ ] **Step 4: 通过 + 合并**

```bash
cd apps/api && bun test test/config-seed.test.ts
git add apps/api/src/services/config.ts apps/api/src/config/billing-seed.ts apps/api/test/config-seed.test.ts
git commit -m "feat(spec301): 种子配置加载器(getConfig/getConfigs/seedConfigs + 占位定价)"
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout main && git merge --no-ff phase3/spec301-billing-data-model -m "merge spec301: 计费数据模型 + 配置化"
git push origin main
```

---

## 验收清单（spec301）

> **增量说明（note）：** 本 spec 是建表基线；`referrals` 后续由 spec307 ALTER 加 `device_hash/signup_ip/frozen_reason` 列、status 增 frozen；`plans` 由 spec308 加稳定 `tier`/`code` 列；新增表 `reconcile_diffs`(spec306)/`referral_codes`/`referral_risk_audits`(spec307)由对应 spec 增量建，不在本 spec 9 表内，非漏建。

- [ ] 9 张表建好（plans/subscriptions/credit_transactions/credit_balances/payment_orders/payment_terminals/refunds/referrals/billing_configs），字段对齐规格文档第四节（2026-07 修订版：无 payment_agreements）。
- [ ] `credit_transactions` append-only + `idempotency_key` 唯一约束；`payment_orders` 幂等键唯一；`referrals` invitee 唯一。
- [ ] 金额统一 `*_cents`(integer 分)；积分 `integer`；数值字段不写死真实定价。
- [ ] `config` 服务：`getConfig/getConfigs/seedConfigs`；种子占位值可读、`seedConfigs` 不覆盖已改值。
- [ ] `bun test` 全绿；迁移可重复跑。
