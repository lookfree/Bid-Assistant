# spec307 · 推荐奖励引擎（邀请 · 规则全配置化） 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现一套**通用邀请奖励引擎**：每用户一个邀请码 → 被邀请人注册建关系 → 两段发放（立即 + 延迟解锁）→ 双方各得配置额度 → 单用户封顶 capped → 防刷风控冻结。**奖励数值/解锁条件/封顶/有效期全部来自 `billing_configs`（spec301 的 `referral_rules` + `reward_expire_days`），代码不写死任何数值**。奖励落 `credit_transactions` 的 `referral_reward` 流水，走 spec302 `credits.grant` 的幂等键 + 有效期。被邀请人首次付费的解锁钩子 `onInviteeFirstPaid(inviteeId)` 由本 spec 导出，供 spec304 支付成功 / 会员激活处调用。

**Architecture:**
- **关系**：`referrals`（spec301 已建：`inviter_id`/`invitee_id`/`code`/`status(pending|bound)`/`reward_state(pending|unlocked|capped)`）。邀请码绑定邀请人（每用户唯一一个），被邀请人注册带 code → 建一条 `referrals`（`invitee_id` 唯一约束防多绑）。
- **两段发放**（条件全由 `referral_rules` 配置开关决定）：
  - ① **立即发放**：若配置启用（如 `inviteeReward` 在注册即发 / `unlockOn` 为空），绑定即给。
  - ② **延迟解锁**：`unlockOn="invitee_first_paid"` → 被邀请人首次付费触发 `onInviteeFirstPaid` → 把 `reward_state` 从 `pending` 推到 `unlocked` 并发双方奖励。
- **奖励落账**：调 spec302 `credits.grant(userId, amount, { type:"referral_reward", expireAt, ref, idempotencyKey })`；`amount` 取自配置 `inviterReward`/`inviteeReward`；`expireAt = now + reward_expire_days`；幂等键 `referral:<referralId>:inviter` / `referral:<referralId>:invitee`（同一关系同一角色只发一次）。
- **封顶**：发奖励前算该用户**累计 `referral_reward` 流水之和**，若 `+本次 > capPerUser` → 跳过发放、把该用户相关 `referrals.reward_state` 标 `capped`。
- **防刷风控**：手机号/设备唯一校验（建关系前查重）；异常邀请（同 IP 段、集中时段、注册即弃）标记冻结（`referrals.status` 不进入可发奖状态 + 写风控审计 `referral_risk_audits`）。
- **路由**：`GET /api/referral/code`（我的邀请码）、`GET /api/referral/list`（邀请列表 + 奖励状态）。

**Tech Stack:** Hono 4.12、Bun、Drizzle ORM、PostgreSQL（public schema，事务）、Zod、bun:test。

## Global Constraints

见 `spec300-index.md`。本 spec 关键：
- **规则全配置化**：奖励数值、`unlockOn`、`capPerUser`、`reward_expire_days` 一律 `getConfig("referral_rules")` / `getConfig("reward_expire_days")`（spec301 种子已占位 `{inviterReward:50,inviteeReward:50,unlockOn:"invitee_first_paid",capPerUser:500}`、`reward_expire_days:30`）。**代码不写死任何数值**——测试用配置注入，断言"等于配置值"，不断言魔数 50。
- 奖励是积分账本里的一笔，**走 spec302 `credits.grant`** 的幂等/有效期/FIFO，不另起一套发放逻辑。
- 钱只在 App API 动；本 spec 不碰支付，只在被邀请人首次付费时被回调 `onInviteeFirstPaid`。
- `referrals.invitee_id` 唯一（spec301 已建约束）保证一个被邀请人只属一个邀请关系。
- 敏感/异常操作留审计（风控冻结写 `referral_risk_audits`）。
- TDD（bun test，真实 TS，不占位）；`main` 上先开分支 `phase3/spec307-referral-engine`；频繁提交（提交信息遵循仓库 CLAUDE.md 规范，不加 `Co-Authored-By`）。

---

## File Structure

```
apps/api/src/
├── db/schema/billing.ts          # 改：扩展 referrals（device_hash/risk_flag）+ 新增 referral_codes / referral_risk_audits
├── services/referral.ts          # 新：引擎主体（getMyCode/bind/grantRewards/onInviteeFirstPaid/list）
├── services/referral-risk.ts     # 新：防刷风控（手机/设备查重 + 异常判定 + 冻结审计）
├── services/referral-errors.ts   # 新：DuplicateInviteeError / SelfReferralError / ReferralFrozenError
└── routes/referral.ts            # 新：GET /api/referral/code、GET /api/referral/list
apps/api/test/
├── referral-code.test.ts         # 新：邀请码生成/查询 + 绑定关系（invitee 唯一/自荐拦截）
├── referral-reward.test.ts       # 新：两段发放 + 双方额度 + 封顶 capped + 幂等不重发
├── referral-risk.test.ts         # 新：手机/设备查重 + 异常邀请冻结 + 审计留痕
└── referral-routes.test.ts       # 新：两个 GET 路由
```

> 若 `apps/api/src/db/schema/billing.ts` 行数因扩展超 1000 行，按全局规则拆分（如 `referral.ts` 独立 schema 文件）。

---

## Interfaces

- **Consumes（来自前序 spec，按其契约调用，不重新实现）：**
  - spec301 `referrals`、`billingConfigs` 表；`getConfig(key)`（`referral_rules`、`reward_expire_days`）。
  - spec302 `credits.grant(userId, amount, { type:"referral_reward", expireAt, ref, idempotencyKey })`。
  - Phase 0 `users`（C 端账号；手机号取自 `users` / `user_identities`）。
- **Produces（本 spec 对外产出，供 spec304/305/308/310 依赖）：** `referral` 服务：
  - `getMyCode(userId) -> Promise<string>`（无则生成并持久化，幂等：每用户唯一一个码）。
  - `bindByCode(opts: { code: string; inviteeId: string; phone?: string; deviceHash?: string; ip?: string }) -> Promise<{ referralId: string; rewarded: boolean }>`（注册时调；建关系 + 风控 + 立即发放分支）。
  - `onInviteeFirstPaid(inviteeId: string) -> Promise<void>`（**导出钩子**：由 spec304 `markPaid` 充值成功分支 + spec308 会员激活成功处调用（幂等）→ 延迟解锁发奖；本 spec 只导出钩子，不接线）。
  - `listReferrals(inviterId) -> Promise<Array<{ inviteeId: string|null; status: string; rewardState: string; createdAt: Date }>>`。
  - 错误：`DuplicateInviteeError`、`SelfReferralError`、`ReferralFrozenError`。
  - 路由：`GET /api/referral/code`、`GET /api/referral/list`（挂到 app router）。

---

## Task 1: schema 扩展（邀请码表 + 风控字段 + 审计表）

**Files:** Modify `apps/api/src/db/schema/billing.ts`；Create 迁移；Create `apps/api/test/referral-code.test.ts`（先空壳）

- [ ] **Step 1: 开分支**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout -b phase3/spec307-referral-engine
```

- [ ] **Step 2: 在 `db/schema/billing.ts` 追加邀请码表、风控审计表，并给 `referrals` 补风控字段**

```typescript
import { pgTable, uuid, text, jsonb, timestamp, integer, index, unique } from "drizzle-orm/pg-core";
import { users } from "./users";

// referrals 已在 spec301 建（inviter_id/invitee_id/code/status/reward_state）。
// 这里补风控落点字段（建关系时记录，供风控判定/审计）：
// deviceHash / signupIp 用于异常邀请识别；frozenReason 记冻结原因。
// 用一条迁移 ALTER TABLE 加列：device_hash text, signup_ip text, frozen_reason text。
// 并 ALTER referrals.status 枚举注释为 pending/bound/frozen（spec301 已登记 frozen=风控冻结，
// 本 spec Task 5 风控写入 status="frozen"）——同迁移更新列注释，不引入新 CHECK。

// 每用户唯一一个邀请码（生成即持久化）
export const referralCodes = pgTable("referral_codes", {
  userId: uuid("user_id").primaryKey().references(() => users.id),
  code: text("code").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  codeUq: unique("referral_codes_code_uq").on(t.code),     // 码全局唯一
}));

// 风控审计：异常邀请冻结留痕（操作/原因/前后值，与运营审计同精神）
export const referralRiskAudits = pgTable("referral_risk_audits", {
  id: uuid("id").defaultRandom().primaryKey(),
  referralId: uuid("referral_id"),                          // 关联 referrals（可空：建关系前命中也记）
  inviteeId: uuid("invitee_id"),
  reason: text("reason").notNull(),                         // duplicate_phone/duplicate_device/same_ip_burst/abandon...
  detail: jsonb("detail").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({ inviteeIdx: index("referral_risk_invitee_idx").on(t.inviteeId) }));
```

并在 `referrals` 表定义上补三列（同文件改 spec301 的 `referrals` 定义，新增 `deviceHash`/`signupIp`/`frozenReason`，均可空）。

- [ ] **Step 3: 生成迁移 + 空壳测试 + 跑通**

```bash
cd apps/api && bun run drizzle-kit generate
```
`test/referral-code.test.ts`：先放 `test("placeholder", () => expect(true).toBe(true))`，确认迁移可跑、新表/新列创建。

- [ ] **Step 4: 提交**

```bash
git add apps/api/src/db/schema/billing.ts apps/api/drizzle apps/api/test/referral-code.test.ts
git commit -m "feat(spec307): referral_codes/referral_risk_audits 表 + referrals 风控字段"
```

---

## Task 2: 邀请码（生成/查询）+ 绑定关系（invitee 唯一 / 自荐拦截）

**Files:** Create `apps/api/src/services/referral.ts`、`services/referral-errors.ts`；Modify `test/referral-code.test.ts`

- [ ] **Step 1: 写 `services/referral-errors.ts`**

```typescript
export class DuplicateInviteeError extends Error {
  constructor(public inviteeId: string) { super(`被邀请人已绑定邀请关系：${inviteeId}`); this.name = "DuplicateInviteeError"; }
}
export class SelfReferralError extends Error {
  constructor() { super("不能使用自己的邀请码"); this.name = "SelfReferralError"; }
}
export class ReferralFrozenError extends Error {
  constructor(public reason: string) { super(`邀请被风控冻结：${reason}`); this.name = "ReferralFrozenError"; }
}
```

- [ ] **Step 2: 写 `services/referral.ts`（getMyCode + 内部 code→inviter 解析）**

```typescript
import { db } from "../db";
import { referralCodes, referrals } from "../db/schema/billing";
import { eq } from "drizzle-orm";

// 6 位大写字母数字码（去掉易混 O/0/I/1）；冲突重试
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function genCode(len = 6): string {
  let s = ""; for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

/** 每用户唯一一个邀请码：已有则返回，无则生成持久化（冲突重试）。 */
export async function getMyCode(userId: string): Promise<string> {
  const [exist] = await db.select().from(referralCodes).where(eq(referralCodes.userId, userId));
  if (exist) return exist.code;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = genCode();
    const [ins] = await db.insert(referralCodes).values({ userId, code })
      .onConflictDoNothing({ target: referralCodes.userId }).returning();
    if (ins) return ins.code;
    // userId 冲突（并发）→ 读回
    const [again] = await db.select().from(referralCodes).where(eq(referralCodes.userId, userId));
    if (again) return again.code;
    // code 冲突 → 重试
  }
  throw new Error("生成邀请码失败");
}

/** code -> inviterId（无效码返回 undefined）。 */
export async function resolveInviter(code: string): Promise<string | undefined> {
  const [row] = await db.select().from(referralCodes).where(eq(referralCodes.code, code));
  return row?.userId;
}
```

- [ ] **Step 3: 写 `bindByCode`（建关系；invitee 唯一 + 自荐拦截；先不发奖，奖发放放 Task 3）**

```typescript
import { DuplicateInviteeError, SelfReferralError } from "./referral-errors";

/** 注册时调：把被邀请人与邀请码绑定，建 referrals（reward_state=pending）。
 *  风控与发奖在后续 Task 接入；本步先保证唯一/自荐约束。 */
export async function bindByCode(opts: {
  code: string; inviteeId: string; phone?: string; deviceHash?: string; ip?: string;
}): Promise<{ referralId: string; rewarded: boolean }> {
  const inviterId = await resolveInviter(opts.code);
  if (!inviterId) throw new Error("无效邀请码");
  if (inviterId === opts.inviteeId) throw new SelfReferralError();

  // invitee 唯一（spec301 约束兜底）：已绑定 → 报错
  const [dup] = await db.select().from(referrals).where(eq(referrals.inviteeId, opts.inviteeId));
  if (dup) throw new DuplicateInviteeError(opts.inviteeId);

  // 注意：下面这个 INSERT 是本 Task 的临时版（恒写 status="bound"）。
  // 它在 Task 5 接风控后改写为带 device_hash/signup_ip + frozen 判定的最终版
  // （status 由 verdict.frozen 决定 bound/frozen，并写 frozenReason）——届时以 Task 5 为准，
  // 不要两处并存重复 INSERT。
  const [ins] = await db.insert(referrals).values({
    inviterId, inviteeId: opts.inviteeId, code: opts.code,
    status: "bound", rewardState: "pending",
    deviceHash: opts.deviceHash, signupIp: opts.ip,
  }).returning();
  return { referralId: ins.id, rewarded: false };
}
```

- [ ] **Step 4: 失败测试 `test/referral-code.test.ts`**

```typescript
import { getMyCode, bindByCode, resolveInviter } from "../src/services/referral";
import { DuplicateInviteeError, SelfReferralError } from "../src/services/referral-errors";

test("getMyCode：每用户唯一一个码，幂等", async () => {
  const u = await makeTestUser();
  const c1 = await getMyCode(u);
  const c2 = await getMyCode(u);
  expect(c1).toBe(c2);
  expect(await resolveInviter(c1)).toBe(u);
});

test("bindByCode：建关系 + invitee 唯一 + 自荐拦截", async () => {
  const inviter = await makeTestUser();
  const invitee = await makeTestUser();
  const code = await getMyCode(inviter);

  // 自荐拦截
  await expect(bindByCode({ code, inviteeId: inviter })).rejects.toBeInstanceOf(SelfReferralError);

  const r = await bindByCode({ code, inviteeId: invitee });
  expect(r.referralId).toBeTruthy();

  // 同一被邀请人二次绑定 → DuplicateInviteeError
  const inviter2 = await makeTestUser();
  const code2 = await getMyCode(inviter2);
  await expect(bindByCode({ code: code2, inviteeId: invitee })).rejects.toBeInstanceOf(DuplicateInviteeError);
});
```

- [ ] **Step 5: 通过 + 提交**

```bash
cd apps/api && bun test test/referral-code.test.ts
git add apps/api/src/services/referral.ts apps/api/src/services/referral-errors.ts apps/api/test/referral-code.test.ts
git commit -m "feat(spec307): 邀请码生成/查询 + bindByCode(invitee 唯一/自荐拦截)"
```

---

## Task 3: 两段发放 + 双方额度 + 封顶（规则全读配置）

**Files:** Modify `services/referral.ts`；Create `test/referral-reward.test.ts`

- [ ] **Step 1: 在 `referral.ts` 加封顶判定 + 发奖核心 + 两段发放**

```typescript
import { getConfig } from "./config";
import { grant } from "./credits";
import { creditTransactions } from "../db/schema/credits";
import { and, sql } from "drizzle-orm";

type ReferralRules = {
  inviterReward: number; inviteeReward: number;
  unlockOn: string;        // "" 立即发；"invitee_first_paid" 延迟解锁
  capPerUser: number;
  riskMaxPerIpPerHour: number;   // 同 IP 段每小时绑定阈值（spec301 种子已占位，风控读配置不写死）
};

async function getRules(): Promise<ReferralRules> {
  const r = await getConfig<ReferralRules>("referral_rules");
  if (!r) throw new Error("缺少 referral_rules 配置");
  return r;
}

/** 该用户累计 referral_reward 流水之和（封顶判定用，仅正向奖励）。 */
async function rewardedSoFar(userId: string): Promise<number> {
  const [row] = await db.select({
    total: sql<number>`coalesce(sum(case when ${creditTransactions.amount}>0 then ${creditTransactions.amount} else 0 end),0)`,
  }).from(creditTransactions).where(and(
    eq(creditTransactions.userId, userId), eq(creditTransactions.type, "referral_reward"),
  ));
  return Number(row?.total ?? 0);
}

/** 给某用户发一笔奖励：封顶则跳过并标 capped；否则走 credits.grant（幂等键防重发）。
 *  返回是否实际发了。 */
async function grantReward(opts: {
  userId: string; amount: number; referralId: string; role: "inviter" | "invitee"; cap: number; expireDays: number;
}): Promise<boolean> {
  if (opts.amount <= 0) return false;
  const already = await rewardedSoFar(opts.userId);
  if (already + opts.amount > opts.cap) {
    // 封顶：只标当前这一条 referral 为 capped（按 referralId，绝不批量刷该 inviter 名下
    // 全部关系——否则会把已 unlocked 的旧关系误刷成 capped）。
    await db.update(referrals).set({ rewardState: "capped" })
      .where(eq(referrals.id, opts.referralId));
    return false;
  }
  const expireAt = new Date(Date.now() + opts.expireDays * 86400_000);
  await grant(opts.userId, opts.amount, {
    type: "referral_reward", expireAt, ref: `referral:${opts.referralId}`,
    idempotencyKey: `referral:${opts.referralId}:${opts.role}`,   // 同关系同角色只发一次
  });
  return true;
}

/** 解锁并发双方奖励：把 reward_state pending→unlocked，给邀请人/被邀请人各发配置额度。 */
async function unlockAndReward(referralId: string): Promise<void> {
  const rules = await getRules();
  const expireDays = Number((await getConfig<number>("reward_expire_days")) ?? 0);
  const [r] = await db.select().from(referrals).where(eq(referrals.id, referralId));
  if (!r || r.rewardState === "capped") return;
  if (!r.inviteeId) return;

  // 按本关系两方各自的发放结果判定状态（grantReward 返回是否实际发了）。
  // 注意：grantReward 封顶时只标当前这一条 referral=capped（按 referralId），不批量刷。
  const inviterPaid = await grantReward({ userId: r.inviterId, amount: rules.inviterReward, referralId, role: "inviter", cap: rules.capPerUser, expireDays });
  const inviteePaid = await grantReward({ userId: r.inviteeId, amount: rules.inviteeReward, referralId, role: "invitee", cap: rules.capPerUser, expireDays });

  // 本关系任一方发放成功 → 置 unlocked（即便另一方因封顶把本条标了 capped，也以"发出去了"为准推进）。
  // 两方都没发出（全 0 额度 / 全封顶）→ 不动状态（封顶时 grantReward 内部已按 referralId 置 capped）。
  if (inviterPaid || inviteePaid) {
    await db.update(referrals).set({ rewardState: "unlocked" }).where(eq(referrals.id, referralId));
  }
}
```

- [ ] **Step 2: 改 `bindByCode` 接入"立即发放"分支（`unlockOn` 为空时绑定即发）**

```typescript
// 在 bindByCode 建关系后追加：
const rules = await getRules();
let rewarded = false;
if (!rules.unlockOn) {                 // 配置为立即发放
  await unlockAndReward(ins.id);
  rewarded = true;
}
return { referralId: ins.id, rewarded };
```

- [ ] **Step 3: 失败测试 `test/referral-reward.test.ts`（断言"等于配置值"，不写死魔数）**

```typescript
import { getMyCode, bindByCode, onInviteeFirstPaid } from "../src/services/referral";
import { getBalance } from "../src/services/credits";
import { getConfig, seedConfigs } from "../src/services/config";
import { db } from "../src/db";
import { billingConfigs } from "../src/db/schema/billing";

beforeEach(async () => { await seedConfigs(); });

test("延迟解锁：首次付费后双方各得配置额度（referral_reward 流水）", async () => {
  const rules = await getConfig<any>("referral_rules");   // unlockOn = invitee_first_paid（种子）
  const inviter = await makeTestUser();
  const invitee = await makeTestUser();
  const code = await getMyCode(inviter);

  const { rewarded } = await bindByCode({ code, inviteeId: invitee });
  expect(rewarded).toBe(false);                            // 延迟解锁，绑定时不发
  expect(await getBalance(inviter)).toBe(0);

  await onInviteeFirstPaid(invitee);                       // 钩子触发解锁
  expect(await getBalance(inviter)).toBe(rules.inviterReward);  // == 配置值，不写死
  expect(await getBalance(invitee)).toBe(rules.inviteeReward);
});

test("立即发放：unlockOn 为空时绑定即发", async () => {
  // 改配置为立即发放
  await db.update(billingConfigs).set({ value: { inviterReward: 20, inviteeReward: 30, unlockOn: "", capPerUser: 1000 } })
    .where(eq(billingConfigs.key, "referral_rules"));
  const inviter = await makeTestUser(); const invitee = await makeTestUser();
  const code = await getMyCode(inviter);
  const { rewarded } = await bindByCode({ code, inviteeId: invitee });
  expect(rewarded).toBe(true);
  expect(await getBalance(inviter)).toBe(20);
  expect(await getBalance(invitee)).toBe(30);
});

test("幂等：重复触发 onInviteeFirstPaid 不重发", async () => {
  const rules = await getConfig<any>("referral_rules");
  const inviter = await makeTestUser(); const invitee = await makeTestUser();
  const code = await getMyCode(inviter);
  await bindByCode({ code, inviteeId: invitee });
  await onInviteeFirstPaid(invitee);
  await onInviteeFirstPaid(invitee);                       // 二次触发
  expect(await getBalance(inviter)).toBe(rules.inviterReward);  // 仍只一份
});

test("封顶：累计达 capPerUser → capped，不再发", async () => {
  // 配 inviterReward=400, cap=500：第一次发 400 OK；第二次 400 超 500 → capped 不发
  await db.update(billingConfigs).set({ value: { inviterReward: 400, inviteeReward: 0, unlockOn: "invitee_first_paid", capPerUser: 500 } })
    .where(eq(billingConfigs.key, "referral_rules"));
  const inviter = await makeTestUser();
  const i1 = await makeTestUser(); const i2 = await makeTestUser();
  await bindByCode({ code: await getMyCode(inviter), inviteeId: i1 });
  await bindByCode({ code: await getMyCode(inviter), inviteeId: i2 });
  await onInviteeFirstPaid(i1);   // +400 → 400
  await onInviteeFirstPaid(i2);   // +400 > 500 → capped，不发
  expect(await getBalance(inviter)).toBe(400);
});
```

- [ ] **Step 4: 通过 + 提交**

```bash
cd apps/api && bun test test/referral-reward.test.ts
git add apps/api/src/services/referral.ts apps/api/test/referral-reward.test.ts
git commit -m "feat(spec307): 两段发放(立即/延迟解锁)+双方配置额度+封顶 capped(全读配置,幂等)"
```

---

## Task 4: 首次付费解锁钩子 onInviteeFirstPaid（导出给 spec304/会员激活）

**Files:** Modify `services/referral.ts`；Modify `test/referral-reward.test.ts`（上一 Task 已用到，本 Task 实现并补边界）

- [ ] **Step 1: 在 `referral.ts` 实现导出钩子 `onInviteeFirstPaid`**

```typescript
/** 被邀请人首次付费触发：仅当配置 unlockOn==="invitee_first_paid" 且该被邀请人有 pending 关系时解锁发奖。
 *  接线：由 spec304 markPaid 充值成功分支 + spec308 会员激活成功处调用（两处均幂等触发）；
 *        本 spec 只导出钩子，不自行接线到支付/激活流程。
 *  幂等：同一 referral 重复触发不重发——靠 reward_state（已 unlocked/capped → 直接返回）
 *        + credits.grant 幂等键（referral:<id>:inviter / :invitee）双重兜底。 */
export async function onInviteeFirstPaid(inviteeId: string): Promise<void> {
  const rules = await getRules();
  if (rules.unlockOn !== "invitee_first_paid") return;     // 配置非该触发条件 → 不处理
  const [r] = await db.select().from(referrals).where(eq(referrals.inviteeId, inviteeId));
  if (!r) return;                                          // 该用户不是被邀请人
  if (r.rewardState !== "pending") return;                // 已解锁/已封顶/已冻结 → 幂等返回
  if (r.status !== "bound") return;                       // 风控冻结（status!=bound）→ 不发
  await unlockAndReward(r.id);
}
```

- [ ] **Step 2: 边界测试补充（在 `referral-reward.test.ts`）**

```typescript
test("onInviteeFirstPaid：非被邀请人 / 无 pending 关系 → 安全空操作", async () => {
  const stranger = await makeTestUser();
  await onInviteeFirstPaid(stranger);                      // 不抛错
  expect(await getBalance(stranger)).toBe(0);
});

test("onInviteeFirstPaid：配置 unlockOn 改为空(立即发) 时钩子不重复发", async () => {
  await db.update(billingConfigs).set({ value: { inviterReward: 10, inviteeReward: 10, unlockOn: "", capPerUser: 1000 } })
    .where(eq(billingConfigs.key, "referral_rules"));
  const inviter = await makeTestUser(); const invitee = await makeTestUser();
  await bindByCode({ code: await getMyCode(inviter), inviteeId: invitee });  // 立即发了 10/10
  await onInviteeFirstPaid(invitee);                       // unlockOn!=invitee_first_paid → 直接返回
  expect(await getBalance(invitee)).toBe(10);              // 不重发
});
```

- [ ] **Step 3: 通过 + 提交**

```bash
cd apps/api && bun test test/referral-reward.test.ts
git add apps/api/src/services/referral.ts apps/api/test/referral-reward.test.ts
git commit -m "feat(spec307): 导出 onInviteeFirstPaid 解锁钩子(幂等+配置条件守卫)"
```

---

## Task 5: 防刷风控（手机/设备查重 + 异常邀请冻结 + 审计留痕）

**Files:** Create `services/referral-risk.ts`；Modify `services/referral.ts`（bindByCode 接风控）；Create `test/referral-risk.test.ts`

- [ ] **Step 1: 写 `services/referral-risk.ts`（判定 + 审计）**

```typescript
import { db } from "../db";
import { referrals, referralRiskAudits } from "../db/schema/billing";
import { and, eq, gte, sql } from "drizzle-orm";

export type RiskVerdict = { frozen: boolean; reason?: string };

/** 风控判定（建关系前调）：
 *  - 手机号唯一：同手机已绑过 → 冻结。
 *  - 设备唯一：同 deviceHash 已绑过 → 冻结。
 *  - 同 IP 段集中时段：最近 1 小时同 signup_ip 绑定数超阈值 → 冻结。
 *  阈值由调用方从配置读出后注入（referral_rules.riskMaxPerIpPerHour，spec301 种子已含该键，不写死）。 */
export async function assessRisk(opts: {
  inviteeId: string; phone?: string; deviceHash?: string; ip?: string; maxPerIpPerHour: number;
}): Promise<RiskVerdict> {
  // 设备查重
  if (opts.deviceHash) {
    const [d] = await db.select().from(referrals).where(eq(referrals.deviceHash, opts.deviceHash));
    if (d) return { frozen: true, reason: "duplicate_device" };
  }
  // 同 IP 段集中时段
  if (opts.ip) {
    const since = new Date(Date.now() - 3600_000);
    const [c] = await db.select({ n: sql<number>`count(*)` }).from(referrals)
      .where(and(eq(referrals.signupIp, opts.ip), gte(referrals.createdAt, since)));
    if (Number(c?.n ?? 0) >= opts.maxPerIpPerHour) return { frozen: true, reason: "same_ip_burst" };
  }
  // 手机号查重：手机取自 users/user_identities（此处按 inviteeId 关联查询，省略具体 join）
  // 命中 → return { frozen: true, reason: "duplicate_phone" }
  return { frozen: false };
}

/** 冻结：写审计留痕（reason + detail 前后值）。 */
export async function freezeAndAudit(opts: {
  referralId?: string; inviteeId: string; reason: string; detail?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(referralRiskAudits).values({
    referralId: opts.referralId, inviteeId: opts.inviteeId, reason: opts.reason, detail: opts.detail ?? {},
  });
}
```

- [ ] **Step 2: 在 `bindByCode` 接入风控（命中 → 建 frozen 关系 + 审计，不发奖）**

```typescript
import { assessRisk, freezeAndAudit } from "./referral-risk";
import { ReferralFrozenError } from "./referral-errors";

// 这是 referrals INSERT 的最终版（替换 Task 2 的临时 INSERT，单处收敛）：
// 先风控判定，再据 verdict.frozen 决定 status=bound|frozen。
const rules = await getRules();
const verdict = await assessRisk({
  inviteeId: opts.inviteeId, phone: opts.phone, deviceHash: opts.deviceHash, ip: opts.ip,
  maxPerIpPerHour: rules.riskMaxPerIpPerHour,                // 阈值读配置（spec301 种子已含该键）
});

const [ins] = await db.insert(referrals).values({
  inviterId, inviteeId: opts.inviteeId, code: opts.code,
  status: verdict.frozen ? "frozen" : "bound",             // 冻结则 status=frozen，不进入可发奖
  rewardState: "pending",
  deviceHash: opts.deviceHash, signupIp: opts.ip,
  frozenReason: verdict.reason,
}).returning();

if (verdict.frozen) {
  await freezeAndAudit({ referralId: ins.id, inviteeId: opts.inviteeId, reason: verdict.reason!, detail: { ip: opts.ip, deviceHash: opts.deviceHash } });
  return { referralId: ins.id, rewarded: false };          // 冻结：建关系但不发奖
}
// 非冻结 → 立即发放分支（同 Task 3）
```

> 冻结的关系 `status="frozen"`，`onInviteeFirstPaid` 已守卫 `status!=="bound"` 不发奖；运营后台（spec310）可人工解冻/发放并审计。

- [ ] **Step 3: 失败测试 `test/referral-risk.test.ts`**

```typescript
import { getMyCode, bindByCode } from "../src/services/referral";
import { db } from "../src/db";
import { referrals, referralRiskAudits } from "../src/db/schema/billing";
import { eq } from "drizzle-orm";
import { seedConfigs } from "../src/services/config";

beforeEach(async () => { await seedConfigs(); });

test("设备查重：同 deviceHash 二次邀请 → 冻结 + 审计留痕", async () => {
  const inviter = await makeTestUser();
  const code = await getMyCode(inviter);
  const dev = "device-abc";
  await bindByCode({ code, inviteeId: await makeTestUser(), deviceHash: dev });
  const r2 = await bindByCode({ code, inviteeId: await makeTestUser(), deviceHash: dev });
  const [rec] = await db.select().from(referrals).where(eq(referrals.id, r2.referralId));
  expect(rec.status).toBe("frozen");
  expect(rec.frozenReason).toBe("duplicate_device");
  const audits = await db.select().from(referralRiskAudits).where(eq(referralRiskAudits.referralId, r2.referralId));
  expect(audits.length).toBeGreaterThan(0);
});

test("冻结关系：首次付费也不发奖", async () => {
  const { onInviteeFirstPaid } = await import("../src/services/referral");
  const { getBalance } = await import("../src/services/credits");
  const inviter = await makeTestUser();
  const code = await getMyCode(inviter);
  const dev = "dup-dev";
  const victim1 = await makeTestUser(); const victim2 = await makeTestUser();
  await bindByCode({ code, inviteeId: victim1, deviceHash: dev });
  await bindByCode({ code, inviteeId: victim2, deviceHash: dev });   // victim2 冻结
  await onInviteeFirstPaid(victim2);
  expect(await getBalance(inviter)).toBe(0);                         // 冻结关系不发
});
```

- [ ] **Step 4: 通过 + 提交**

```bash
cd apps/api && bun test test/referral-risk.test.ts
git add apps/api/src/services/referral-risk.ts apps/api/src/services/referral.ts apps/api/test/referral-risk.test.ts
git commit -m "feat(spec307): 防刷风控(手机/设备查重+同IP集中时段→冻结+审计留痕)"
```

---

## Task 6: 路由（GET /api/referral/code、GET /api/referral/list）

**Files:** Create `apps/api/src/routes/referral.ts`；Modify app router 挂载；Create `test/referral-routes.test.ts`

- [ ] **Step 1: 在 `referral.ts` 服务加 `listReferrals`**

```typescript
/** 邀请列表 + 奖励状态（供 /api/referral/list 与会员中心 spec308）。 */
export async function listReferrals(inviterId: string): Promise<Array<{
  inviteeId: string | null; status: string; rewardState: string; createdAt: Date;
}>> {
  const rows = await db.select({
    inviteeId: referrals.inviteeId, status: referrals.status,
    rewardState: referrals.rewardState, createdAt: referrals.createdAt,
  }).from(referrals).where(eq(referrals.inviterId, inviterId)).orderBy(referrals.createdAt);
  return rows;
}
```

- [ ] **Step 2: 写 `routes/referral.ts`（Hono，从会话取当前用户）**

```typescript
import { Hono } from "hono";
import { getMyCode, listReferrals } from "../services/referral";
// 复用 Phase 0 的会话中间件取 userId（按现有 auth 约定）

export const referralRoutes = new Hono();

referralRoutes.get("/code", async (c) => {
  const userId = c.get("userId");                          // 来自鉴权中间件
  const code = await getMyCode(userId);
  return c.json({ code });
});

referralRoutes.get("/list", async (c) => {
  const userId = c.get("userId");
  const list = await listReferrals(userId);
  return c.json({ list });
});
```

并在 app 主路由挂载：`app.route("/api/referral", referralRoutes)`（沿用 Phase 0/1 的挂载方式与鉴权中间件）。

- [ ] **Step 3: 失败测试 `test/referral-routes.test.ts`**

```typescript
// 用 app.request 发请求；以测试夹具注入已登录 userId（沿用 Phase 0 测试鉴权 helper）
test("GET /api/referral/code 返回我的邀请码（幂等同一码）", async () => {
  const { app, login } = await import("./helpers");          // 现有测试 helper
  const userId = await makeTestUser();
  const headers = await login(userId);
  const r1 = await app.request("/api/referral/code", { headers });
  const r2 = await app.request("/api/referral/code", { headers });
  expect(r1.status).toBe(200);
  expect((await r1.json()).code).toBe((await r2.json()).code);
});

test("GET /api/referral/list 返回邀请列表 + 奖励状态", async () => {
  const { app, login } = await import("./helpers");
  const inviter = await makeTestUser();
  const code = await (await import("../src/services/referral")).getMyCode(inviter);
  await (await import("../src/services/referral")).bindByCode({ code, inviteeId: await makeTestUser() });
  const headers = await login(inviter);
  const res = await app.request("/api/referral/list", { headers });
  const body = await res.json();
  expect(body.list.length).toBe(1);
  expect(body.list[0]).toHaveProperty("rewardState");
});
```

- [ ] **Step 4: 通过 + 合并**

```bash
cd apps/api && bun test
git add apps/api/src/routes/referral.ts apps/api/src/services/referral.ts apps/api/test/referral-routes.test.ts
git commit -m "feat(spec307): 路由 GET /api/referral/code + /list"
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout main && git merge --no-ff phase3/spec307-referral-engine -m "merge spec307: 推荐奖励引擎(规则全配置化)"
git push origin main
```

---

## 验收清单（spec307）

- [ ] **邀请码**：每用户唯一一个码（`getMyCode` 幂等生成/查询）；`code→inviter` 可解析；码全局唯一。
- [ ] **绑定关系**：被邀请人注册带 code → 建 `referrals`（`status=bound`/`reward_state=pending`）；`invitee_id` 唯一（重复绑 `DuplicateInviteeError`）；自荐拦截（`SelfReferralError`）。
- [ ] **两段发放**：立即发放（`unlockOn` 为空，绑定即发）与延迟解锁（`unlockOn="invitee_first_paid"`，首付触发）均按配置生效。
- [ ] **双方额度**：邀请人/被邀请人各得 `inviterReward`/`inviteeReward`（**测试断言等于配置值，代码不写死数值**）；奖励落 `referral_reward` 流水，带 `reward_expire_days` 有效期。
- [ ] **幂等**：幂等键 `referral:<id>:inviter` / `:invitee`；重复触发 `onInviteeFirstPaid` 不重发。
- [ ] **封顶**：单用户累计 `referral_reward` 达 `capPerUser` → `reward_state=capped`，不再发。
- [ ] **导出钩子**：`onInviteeFirstPaid(inviteeId)` 导出且幂等、受配置条件与冻结状态守卫；供 spec304/会员激活调用。
- [ ] **防刷风控**：手机/设备查重 + 同 IP 集中时段 → `status=frozen` + 写 `referral_risk_audits` 审计；冻结关系不发奖。
- [ ] **路由**：`GET /api/referral/code`、`GET /api/referral/list` 接真实数据（邀请列表 + 奖励状态）。
- [ ] `bun test` 全绿；迁移可重复跑；分支 `phase3/spec307-referral-engine` 合并入 `main`。
