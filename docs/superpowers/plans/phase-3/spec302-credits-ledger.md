# spec302 · 积分账本引擎（★替换计费 stub） 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现真实**积分账本引擎** `credits` 服务（建在 spec301 表上）：`grant/hold/settle/release/expireDue` + 余额=Σ流水 + 余额缓存 + 幂等键 + FIFO 过期；并**替换 Phase 1/2 的 `billing-stub`**——`preDeduct/settle` 改调真账本，`STEP_COST` 常量删除改读 `billing_configs` 操作口径。这是 Phase 3「积分能真扣」的核心价值。

**Architecture:** 账本是 `credit_transactions` 的 append-only 流水，**余额 = Σ amount**（`credit_balances` 仅缓存 + 对账）。AI 操作两段式：`hold(-N)` 预扣（校验余额≥N、N 取自 `credit_cost.<op>` 配置）→ 成功 `settle`（多退少补，净消耗=实际用量）/ 失败 `release`（净=0）。每个操作带 `idempotency_key`（DB 唯一约束兜底，重复请求不重复扣）。过期 `expireDue` 按 `expire_at` FIFO 扫到期且未消耗的批次写 `expire`。**钱只在 App、智能体只上报 usage**（§3.2）。

**Tech Stack:** Hono、Drizzle ORM、PostgreSQL（事务 + 行锁）、Zod、bun:test。

## Global Constraints

见 `spec300-index.md`。本 spec 关键：
- 余额=Σ流水；`credit_balances` 仅缓存。所有扣减带幂等键（spec301 已建唯一约束）。
- 预扣→结算两段式；N 取自 `billing_configs`（`getConfig("credit_cost.<op>")`，spec301）。
- FIFO by `expire_at`（先过期先扣）。
- 余额校验 + 写 hold 必须在**同一事务**内，并以**锁用户行**（`credit_balances` 该 userId 行 `FOR UPDATE`，行不存在先 upsert 兜底）作串行化点防并发超扣——**不可锁裸流水行**（新用户/首扣无行可锁，谓词锁缺口会超扣）。
- TDD；`main` 上先开分支。

---

## File Structure

```
apps/api/src/
├── services/credits.ts          # 新：账本引擎（grant/hold/settle/release/expireDue/getBalance）
├── services/credits-errors.ts   # 新：InsufficientCreditsError 等
└── services/billing-stub.ts     # 改：preDeduct/settle 委托给 credits（删 STEP_COST，读配置）
apps/api/test/
├── credits.test.ts              # 新：余额=Σ、hold/settle/release、幂等、并发
└── credits-expire.test.ts       # 新：FIFO 过期
```

---

## Interfaces（本 spec 对外产出，供 spec304/305/306/307/308/310 依赖）

- Produces：`credits` 服务：
  - `getBalance(userId) -> Promise<number>`（Σ流水；顺带刷新 `credit_balances`）。
  - `grant(userId, amount, opts: {type?: "grant"|"purchase"|"referral_reward", sourceBatch?, expireAt?, ref?, idempotencyKey}) -> Promise<void>`。
  - `hold(userId, op: string, opts: {ref?, idempotencyKey}) -> Promise<{holdId: string, amount: number}>`（N=`credit_cost.<op>`；余额不足抛 `InsufficientCreditsError`）。
  - `settle(holdId, actualCost, opts: {idempotencyKey}) -> Promise<void>`（多退少补，净消耗=actualCost）。
  - `release(holdId, opts: {idempotencyKey}) -> Promise<void>`（失败全额退还，净=0）。
  - `expireDue(now: Date) -> Promise<number>`（FIFO 扫到期未消耗批次写 expire，返回过期总额；spec306 Cron 调）。
  - `InsufficientCreditsError`。

---

## Task 1: 余额 = Σ流水 + grant 入账

**Files:** Create `apps/api/src/services/credits.ts`、`services/credits-errors.ts`、`apps/api/test/credits.test.ts`

- [ ] **Step 1: 开分支**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout -b phase3/spec302-credits-ledger
```

- [ ] **Step 2: 写 `services/credits-errors.ts`**

```typescript
export class InsufficientCreditsError extends Error {
  constructor(public needed: number, public available: number) {
    super(`积分不足：需 ${needed}，可用 ${available}`);
    this.name = "InsufficientCreditsError";
  }
}
```

- [ ] **Step 3: 写 `services/credits.ts`（getBalance + grant）**

```typescript
import { db } from "../db";
import { creditTransactions, creditBalances } from "../db/schema/credits";
import { eq, sql } from "drizzle-orm";

/** 余额 = Σ流水；顺带刷新缓存。 */
export async function getBalance(userId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${creditTransactions.amount}), 0)` })
    .from(creditTransactions)
    .where(eq(creditTransactions.userId, userId));
  const balance = Number(row?.total ?? 0);
  await db.insert(creditBalances).values({ userId, balance })
    .onConflictDoUpdate({ target: creditBalances.userId, set: { balance, updatedAt: new Date() } });
  return balance;
}

/** 入账：赠送/充值/推荐奖励（带有效期与幂等键）。 */
export async function grant(
  userId: string,
  amount: number,
  opts: { type?: "grant" | "purchase" | "referral_reward"; sourceBatch?: string; expireAt?: Date; ref?: string; idempotencyKey: string },
): Promise<void> {
  await db.insert(creditTransactions).values({
    userId, type: opts.type ?? "grant", amount,
    sourceBatch: opts.sourceBatch, expireAt: opts.expireAt, ref: opts.ref, idempotencyKey: opts.idempotencyKey,
  }).onConflictDoNothing({ target: creditTransactions.idempotencyKey });   // 幂等：重复入账忽略
  await getBalance(userId);
}
```

- [ ] **Step 4: 失败测试 `test/credits.test.ts`**

```typescript
import { getBalance, grant } from "../src/services/credits";

test("余额 = Σ流水, grant 幂等", async () => {
  const userId = await makeTestUser();
  await grant(userId, 100, { idempotencyKey: "g1" });
  await grant(userId, 50, { idempotencyKey: "g2" });
  expect(await getBalance(userId)).toBe(150);
  await grant(userId, 100, { idempotencyKey: "g1" });        // 重复幂等键 → 忽略
  expect(await getBalance(userId)).toBe(150);
});
```

- [ ] **Step 5: 通过 + 提交**

```bash
cd apps/api && bun test test/credits.test.ts
git add apps/api/src/services/credits.ts apps/api/src/services/credits-errors.ts apps/api/test/credits.test.ts
git commit -m "feat(spec302): 账本 getBalance(Σ流水)+grant(幂等入账)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 预扣 hold + 退还 release（事务 + 行锁防并发超扣）

**Files:** Modify `services/credits.ts`、`test/credits.test.ts`

- [ ] **Step 1: 在 `credits.ts` 加 `hold` / `release`**

```typescript
import { getConfig } from "./config";
import { InsufficientCreditsError } from "./credits-errors";

/** 预扣：N=credit_cost.<op>；事务内**锁用户行**校验余额≥N，写 hold(-N)。返回 holdId(=该 tx id)。 */
export async function hold(
  userId: string, op: string, opts: { ref?: string; idempotencyKey: string },
): Promise<{ holdId: string; amount: number }> {
  const n = Number((await getConfig<number>(`credit_cost.${op}`)) ?? 0);
  return await db.transaction(async (tx) => {
    // 幂等：同 key 已 hold 过 → 返回原记录
    const [exist] = await tx.select().from(creditTransactions)
      .where(eq(creditTransactions.idempotencyKey, opts.idempotencyKey));
    if (exist) return { holdId: exist.id, amount: -exist.amount };
    // —— 并发超扣串行化点 ——
    // 不能锁裸流水行：新用户/首扣时 credit_transactions 无行可锁（谓词锁缺口），并发首扣会同时
    // 读到余额、各自插 hold → 超扣。改为**锁该用户在 credit_balances 的行**作串行化点：
    // 先 upsert 兜底建行（保证有行可锁），再 SELECT ... FOR UPDATE 串行化同一 userId 的并发 hold。
    await tx.insert(creditBalances).values({ userId, balance: 0 })
      .onConflictDoNothing({ target: creditBalances.userId });
    await tx.execute(sql`SELECT 1 FROM ${creditBalances} WHERE ${creditBalances.userId} = ${userId} FOR UPDATE`);
    // 持锁后再算余额、校验、插 hold —— 同 userId 的并发 hold 在此串行排队，杜绝超扣。
    const [row] = await tx.select({ total: sql<number>`coalesce(sum(${creditTransactions.amount}),0)` })
      .from(creditTransactions).where(eq(creditTransactions.userId, userId));
    const available = Number(row?.total ?? 0);
    if (available < n) throw new InsufficientCreditsError(n, available);
    const [ins] = await tx.insert(creditTransactions)
      .values({ userId, type: "hold", amount: -n, ref: opts.ref, idempotencyKey: opts.idempotencyKey })
      .returning();
    return { holdId: ins.id, amount: n };
  });
}

/** 失败全额退还：对 holdId 写 release(+N)，净=0。 */
export async function release(holdId: string, opts: { idempotencyKey: string }): Promise<void> {
  const [h] = await db.select().from(creditTransactions).where(eq(creditTransactions.id, holdId));
  if (!h || h.type !== "hold") return;
  await db.insert(creditTransactions).values({
    userId: h.userId, type: "release", amount: -h.amount, ref: h.ref, idempotencyKey: opts.idempotencyKey,
  }).onConflictDoNothing({ target: creditTransactions.idempotencyKey });
  await getBalance(h.userId);
}
```

- [ ] **Step 2: 失败测试（hold 扣减 + 余额不足抛错 + release 还原）**

```typescript
import { hold, release, getBalance, grant } from "../src/services/credits";
import { InsufficientCreditsError } from "../src/services/credits-errors";

test("hold 预扣 + release 全额退还", async () => {
  const userId = await makeTestUser();
  await seedConfigs();                                        // credit_cost.read = 10
  await grant(userId, 30, { idempotencyKey: "g1" });
  const { holdId, amount } = await hold(userId, "read", { ref: "run1", idempotencyKey: "hold:run1" });
  expect(amount).toBe(10);
  expect(await getBalance(userId)).toBe(20);                  // 30 - 10
  await release(holdId, { idempotencyKey: "rel:run1" });
  expect(await getBalance(userId)).toBe(30);                  // 退还
});

test("余额不足抛 InsufficientCreditsError", async () => {
  const userId = await makeTestUser();
  await seedConfigs();
  await grant(userId, 5, { idempotencyKey: "g1" });
  await expect(hold(userId, "read", { idempotencyKey: "hold:x" })).rejects.toBeInstanceOf(InsufficientCreditsError);
});

test("并发首扣不超扣（锁 credit_balances 用户行作串行化点）", async () => {
  // 新用户首扣场景：余额恰够 1 次 hold，10 个并发请求只能成功 1 个，其余抛 InsufficientCreditsError。
  // 验证锁的是用户行（即便 credit_transactions 尚无可锁行），不会并发各自读余额后一起超扣。
  const userId = await makeTestUser();
  await seedConfigs();                                        // credit_cost.read = 10
  await grant(userId, 10, { idempotencyKey: "g1" });
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) =>
      hold(userId, "read", { idempotencyKey: `hold:c${i}` })),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(await getBalance(userId)).toBe(0);                   // 只扣了一次，绝不为负
});
```

- [ ] **Step 3: 通过 + 提交**

```bash
cd apps/api && bun test test/credits.test.ts
git add apps/api/src/services/credits.ts apps/api/test/credits.test.ts
git commit -m "feat(spec302): hold 预扣(事务+行锁防超扣) + release 退还"
```

---

## Task 3: 结算 settle（多退少补）

**Files:** Modify `services/credits.ts`、`test/credits.test.ts`

- [ ] **Step 1: 加 `settle`**

```typescript
/** 结算：对 holdId(已预扣 N) 按实际用量结算，净消耗=actualCost。
 *  写 settle(+ (N - actualCost))：actualCost<N 退差额；>N 补扣（amount 为负）。 */
export async function settle(holdId: string, actualCost: number, opts: { idempotencyKey: string }): Promise<void> {
  const [h] = await db.select().from(creditTransactions).where(eq(creditTransactions.id, holdId));
  if (!h || h.type !== "hold") return;
  const held = -h.amount;                                     // N
  const adjust = held - actualCost;                          // 多退(>0)/少补(<0)
  await db.insert(creditTransactions).values({
    userId: h.userId, type: "settle", amount: adjust, ref: h.ref, idempotencyKey: opts.idempotencyKey,
  }).onConflictDoNothing({ target: creditTransactions.idempotencyKey });
  await getBalance(h.userId);
}
```

- [ ] **Step 2: 失败测试**

```typescript
test("settle 多退少补：净消耗=实际用量", async () => {
  const userId = await makeTestUser();
  await seedConfigs();
  await grant(userId, 30, { idempotencyKey: "g1" });
  const { holdId } = await hold(userId, "read", { ref: "run1", idempotencyKey: "hold:run1" });  // -10
  await settle(holdId, 6, { idempotencyKey: "settle:run1" });                                   // 实际 6 → 退 4
  expect(await getBalance(userId)).toBe(24);                 // 30 -10 +4 = 24（净扣 6）
});
```

- [ ] **Step 3: 通过 + 提交**

```bash
cd apps/api && bun test test/credits.test.ts
git add apps/api/src/services/credits.ts apps/api/test/credits.test.ts
git commit -m "feat(spec302): settle 结算(多退少补, 净消耗=实际用量)"
```

---

## Task 4: FIFO 过期 expireDue

**Files:** Modify `services/credits.ts`、Create `test/credits-expire.test.ts`

- [ ] **Step 1: 加 `expireDue`（按 expire_at 先过期先扣）**

```typescript
import { and, lte, isNotNull } from "drizzle-orm";

/** 过期：扫 expire_at<=now 的入账批次，把其「未被消耗的余量」写 expire 注销。
 *  严格 FIFO 台账：消耗只计**已落地**部分（settle 的净消耗 + 既往 expire + refund_clawback），
 *  **排除未结算的在途 hold**（hold 有对应 settle/release 才算落地，否则不计入消耗）。
 *  按 grant 批次 expire_at 升序从最早起分配消耗，到期批次的剩余 → 写 expire(-剩余)。 */
export async function expireDue(now: Date): Promise<number> {
  // 取该用户所有正入账(带 expire_at)按到期升序 + 总已消耗，逐批分配消耗，剩余且已到期者过期。
  // 实现要点：用户维度分组；consumedRemaining 从最早到期批次起抵扣；到期批次剩余记 expire。
  const users = await db.selectDistinct({ userId: creditTransactions.userId })
    .from(creditTransactions).where(and(isNotNull(creditTransactions.expireAt)));
  let total = 0;
  for (const { userId } of users) {
    total += await _expireUser(userId, now);
  }
  return total;
}

async function _expireUser(userId: string, now: Date): Promise<number> {
  return await db.transaction(async (tx) => {
    const grants = await tx.select().from(creditTransactions)
      .where(and(eq(creditTransactions.userId, userId), isNotNull(creditTransactions.expireAt)))
      .orderBy(creditTransactions.expireAt);                 // 先过期的在前
    // 已落地消耗 = settle/expire/refund_clawback 的负净额（取绝对值累计）。
    // **排除在途 hold**：hold(-N) 只有配上 settle(+差额)/release(+N) 才落地——
    //   - settle 行的 amount = N-actualCost：hold(-N)+settle 合计 = -actualCost（净消耗已落地）；
    //   - release 行的 amount = -h.amount = N（见 release）：hold(-N)+release(+N) 合计 = 0（无消耗）；
    //   - 未结算的裸 hold(-N) 不在下列 type 中 → 不计入 consumed，绝不高估消耗。
    // expire/refund_clawback 均为已落地负向消耗，按普通负流水累计即可。
    const [c] = await tx.select({
      neg: sql<number>`coalesce(-sum(case
        when ${creditTransactions.type} in ('settle','expire','refund_clawback') and ${creditTransactions.amount}<0
        then ${creditTransactions.amount} else 0 end),0)`,
    }).from(creditTransactions).where(eq(creditTransactions.userId, userId));
    let consumed = Number(c?.neg ?? 0);
    let expired = 0;
    for (const g of grants) {
      const live = Math.max(0, g.amount - Math.min(consumed, g.amount));  // 该批被已落地消耗抵扣后剩余
      consumed = Math.max(0, consumed - g.amount);
      const alreadyExpired = false;                          // 简化：靠幂等键防重复过期
      if (g.expireAt && g.expireAt <= now && live > 0 && !alreadyExpired) {
        await tx.insert(creditTransactions).values({
          userId, type: "expire", amount: -live, sourceBatch: g.sourceBatch ?? g.id,
          idempotencyKey: `expire:${g.id}`,
        }).onConflictDoNothing({ target: creditTransactions.idempotencyKey });
        expired += live;
      }
    }
    return expired;
  });
}
```

> FIFO 关键：消耗（**仅已落地：settle 净消耗 + 既往 expire + refund_clawback，排除在途 hold**）从**最早到期**批次起抵扣，使后到期批次承担过期 → "先过期先扣"。在途 hold 不计入消耗，否则会高估消耗、漏过期。`idempotencyKey=expire:<grantId>` 保证同批不重复过期。

- [ ] **Step 2: 失败测试 `test/credits-expire.test.ts`**

```typescript
import { grant, hold, getBalance, expireDue } from "../src/services/credits";

test("FIFO 过期：先过期批次未消耗部分被注销", async () => {
  const userId = await makeTestUser();
  const past = new Date(Date.now() - 86400_000);             // 昨天
  const future = new Date(Date.now() + 86400_000);
  await grant(userId, 50, { idempotencyKey: "early", expireAt: past });   // 早过期
  await grant(userId, 50, { idempotencyKey: "late", expireAt: future });  // 晚过期
  expect(await getBalance(userId)).toBe(100);
  const expired = await expireDue(new Date());
  expect(expired).toBe(50);                                  // 早批次全过期
  expect(await getBalance(userId)).toBe(50);                 // 仅留晚批次
});

test("在途 hold 不计入消耗：过期不被高估（漏过期回归）", async () => {
  // 早批次 50 已过期；有一个在途 hold(-10) 未结算。
  // BUG 行为：Σ负流水把 hold 当消耗 → 误以为早批次已消耗 10 → 只过期 40。
  // 正确行为：在途 hold 不算消耗 → 早批次未被任何已落地消耗抵扣 → 全额过期 50。
  const userId = await makeTestUser();
  await seedConfigs();                                        // credit_cost.read = 10
  const past = new Date(Date.now() - 86400_000);
  const future = new Date(Date.now() + 86400_000);
  await grant(userId, 50, { idempotencyKey: "early", expireAt: past });
  await grant(userId, 50, { idempotencyKey: "late", expireAt: future });
  await hold(userId, "read", { ref: "run1", idempotencyKey: "hold:run1" });  // 在途，未 settle/release
  const expired = await expireDue(new Date());
  expect(expired).toBe(50);                                  // 早批次仍全额过期，不被在途 hold 抵消
});
```

- [ ] **Step 3: 通过 + 提交**

```bash
cd apps/api && bun test test/credits-expire.test.ts
git add apps/api/src/services/credits.ts apps/api/test/credits-expire.test.ts
git commit -m "feat(spec302): expireDue(FIFO 先过期先扣 + 幂等)"
```

---

## Task 5: 替换 billing-stub（接 Phase 1/2 编排）

**Files:** Modify `apps/api/src/services/billing-stub.ts`（spec108/207 建）

- [ ] **Step 1: `billing-stub.ts` 的 preDeduct/settle 委托真账本**

把 stub 改成调 `credits`（保持 spec108/207 的调用签名不变，只换实现）：

```typescript
import { hold, settle as ledgerSettle, release } from "./credits";
import { getConfig } from "./config";

// 删除 STEP_COST 常量；口径改读配置
export async function preDeduct(userId: string, op: string, runId: string): Promise<{ ok: boolean; holdId?: string; amount: number }> {
  try {
    const { holdId, amount } = await hold(userId, op, { ref: runId, idempotencyKey: `hold:${runId}` });
    return { ok: true, holdId, amount };
  } catch {
    return { ok: false, amount: 0 };                         // 余额不足
  }
}

export async function settle(runId: string, holdId: string, actualCost: number): Promise<void> {
  await ledgerSettle(holdId, actualCost, { idempotencyKey: `settle:${runId}` });
}

export async function settleFailed(runId: string, holdId: string): Promise<void> {
  await release(holdId, { idempotencyKey: `release:${runId}` });
}
```

> 注：spec108/207 的编排需顺带传入 `userId`/`op`/`holdId`（之前 stub 没用真实账本，签名要补这几个参数 + 失败分支调 `settleFailed`）。`actualCost` 由 `agent_token_usage` 汇总换算（`getConfig("credit_rate")`）。**编排控制流不变，只是把 stub 接到真账本。**

- [ ] **Step 2: 失败测试**（mock 一个 user + 配置，preDeduct→settle 后余额按净消耗变化；余额不足 preDeduct 返回 ok:false）。

- [ ] **Step 3: 通过 + 合并**

```bash
cd apps/api && bun test
git add apps/api/src/services/billing-stub.ts apps/api/test/billing-stub.test.ts
git commit -m "feat(spec302): billing-stub 接真账本(preDeduct/settle/settleFailed → credits)"
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout main && git merge --no-ff phase3/spec302-credits-ledger -m "merge spec302: 积分账本引擎(替换 stub)"
git push origin main
```

---

## 验收清单（spec302）

- [ ] 余额 = Σ流水；`credit_balances` 缓存刷新；`grant` 幂等。
- [ ] `hold` 事务+行锁校验余额≥N（N 读 `credit_cost.<op>` 配置）、余额不足抛 `InsufficientCreditsError`。
- [ ] `settle` 多退少补（净消耗=实际用量）；`release` 失败全额退还（净=0）；均幂等。
- [ ] `expireDue` FIFO（先过期先扣）+ `expire:<grantId>` 幂等不重复过期。
- [ ] `billing-stub` 的 preDeduct/settle/settleFailed 委托真账本，Phase 1/2 编排控制流不变。
- [ ] `bun test` 全绿。
