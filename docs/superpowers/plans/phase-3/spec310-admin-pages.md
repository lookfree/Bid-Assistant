# spec310 · 运营后台功能页（基于 admin-front 原型 6 页接真实接口） 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `docs/admin-front` 原型的 **6 个运营后台页**（概览 / 用户 users / 订单 orders / 账本 ledger / 套餐&配置 plans / 系统 system）接上**真实 admin-api 接口**，落地三类运营能力：①数据看板与查询（概览/用户/订单/账本/审计日志）②敏感写操作（封禁解封 / 手动调积分 / 退款审批 / 套餐 CRUD / **`billing_configs` 可视化管理** / 运营账号角色管理）③全链路 RBAC + 审计。**所有读写经 spec309 的 `requireAdmin`/`requirePermission` RBAC；所有敏感写操作必须 `writeAudit(operator, action, target, before, after)`**。本 spec 是 Phase 3 运营后台的「功能层」，消费 spec302（账本）、spec306（退款/对账）、spec301（plans/billing_configs）、spec309（admin 身份 + RBAC + 审计装置），不重复实现它们。

> **视觉以 `docs/admin-front` 原型为准**（6 页布局/配色/组件已在原型中定义，本地不可读）。本 spec 只负责 **admin-api 后端接口 + 页面接线契约（请求/响应/权限/审计）**；前端页面按原型结构把占位数据替换为 admin-api 真实响应，不重做视觉。

**Architecture:**
- admin-api 全部挂在 **`/admin-api` 前缀**（与 C 端 `/api`、支付 `/api/payment` 完全分离，§3.3 双子域）。聚合 router `adminApiRouter`（`apps/api/src/routes/admin/index.ts`），`app.route("/admin-api", adminApiRouter)`。
- **每个 admin-api 路由先过 spec309 中间件**：`requireAdmin`（校验 admin 会话 → `c.set("admin", {...})`）+ `requirePermission(action)`（按 RBAC 角色判定 superadmin/ops/finance/support 能否做该操作，不足 → 403）。读接口要求登录（任意角色），写接口要求对应权限。
- **敏感写操作统一审计**：service 层在写库**同一事务/紧邻**调 spec309 `writeAudit({ operator, action, target, before, after })`，落 `admin_audit_logs`。operator 来自 `c.get("admin").username`。覆盖：改套餐、调积分、退款审批、封禁解封、手动发奖励、改 `billing_configs`、改运营账号/角色。
- **`billing_configs` 可视化管理**：plans 页的「配置」区读写 **同一张 `billing_configs`**（spec301 的 `getConfig/getConfigs/setConfig`，`setConfig(key,value)` 为纯写 upsert）。改值 → 立即生效（`getConfig` 下次读到新值，无缓存层；账本 `hold` 读 `credit_cost.<op>` 即用新口径）。每次改配置在 **route 层显式写审计**（前后值）：`const before = await getConfig(key); await setConfig(key, value); await writeAudit({...})`。
- **退款审批**：orders 页发起退款 → 调 spec306 `createRefund`（已实现 pending→done/failed + 订单 refunded + 扣回积分 + 解约），admin-api 只做权限 + operator 注入 + 审计包装。
- **手动调积分**：users 页对单个用户调 spec302 `credits.grant`（正向加 / 负向扣，带运营幂等键 `admin:<adminId>:<ts>`）+ 审计。
- 列表接口统一 `{ items, total, page, pageSize }` 分页 + 关键字/状态过滤；金额单位 `*_cents`（分），前端展示除 100。

**Tech Stack:** Hono 4.12、Bun、Drizzle ORM、PostgreSQL、Zod、bun:test。前端原型为 admin-front（静态/SPA，按原型技术栈，本 spec 不约束其框架，只约束接口契约）。

> **实现契约核对（spec306 落地后）**：① 退款入口调 `createRefund`（`services/refunds`）——注意三态返回 `done|failed|pending`（pending=通道结果不明转人工，不可自动重试）；入参含 `allowNegativeBalance`（扣回超余额时操作员确认）。② 必须补 **reconcile_diffs 差异工作台**：列表（扫 resolved='open'，按 diff_type/subject）、`PATCH resolve`、以及 unknown_paid 的修复动作（人工核实通道后调 `markPaid(orderId, info, { allowStale: true })` 幂等补入账）。③ 差异告警渠道（alertHook）在本 spec 接后台通知（review-followups C12）。

## Global Constraints

见 `spec300-index.md`。本 spec 关键：
- **admin 与 C 端 `users` 完全分离**（§3.3）：admin 身份 `admin_users`、独立会话、独立子域；本 spec 所有接口在 `/admin-api`，绝不复用 C 端 `/api` 鉴权。
- **全部接口经 RBAC**：`requireAdmin` + `requirePermission(action)`（spec309）。**support 角色对敏感写操作必须 403**（只读/工单类权限）。
- **敏感写操作一律 `writeAudit`**（spec309，operator + action + target + before + after）；审计与业务写在同一事务或紧邻，失败回滚。
- 消费既有 service，不重实现：spec302 `credits.grant/getBalance`、spec306 `createRefund`、spec301 `getConfig/getConfigs/setConfig`（`setConfig` 纯写，审计在本 spec route 层做）、spec309 `requireAdmin/requirePermission`（`middleware/admin-auth`）/`writeAudit`（`services/audit`）/`hasPermission/ROLE_PERMISSIONS/Permission`（`services/rbac`）/`admin_users/admin_roles/admin_audit_logs`。
- 金额 `*_cents`（integer 分）；分页统一契约；TDD（bun test）；`main` 上先开分支 `phase3/spec310-admin-pages`。
- 单文件不超 1000 行（用户全局约束），按页/职责拆分。

---

## File Structure

```
apps/api/src/
├── services/
│   ├── config.ts                  # spec301：getConfig/getConfigs/setConfig(key,value)（纯写 upsert，无审计）；本 spec 直接消费，审计在 route 层做
│   └── admin/
│       ├── overview.ts            # 新：概览指标聚合
│       ├── admin-users.ts         # 新：用户列表/详情/封禁解封/手动调积分（接 credits.grant）
│       ├── admin-orders.ts        # 新：订单列表/详情（退款走 spec306 createRefund）
│       ├── ledger.ts              # 新：积分账本查询 + 余额=Σ流水核对
│       ├── admin-plans.ts         # 新：plans CRUD（上下架/改价）
│       └── admin-accounts.ts      # 新：运营账号/角色 CRUD + 审计日志查询（admin_users/admin_audit_logs）
├── routes/admin/
│   ├── index.ts                   # 新：adminApiRouter 聚合（挂 6 组子路由，统一套 requireAdmin）
│   ├── overview.ts                # 新：GET /admin-api/overview
│   ├── users.ts                   # 新：GET/POST /admin-api/users…
│   ├── orders.ts                  # 新：GET/POST /admin-api/orders… + /admin-api/refunds
│   ├── ledger.ts                  # 新：GET /admin-api/ledger…
│   ├── plans.ts                   # 新：GET/PUT/POST /admin-api/plans… + /admin-api/configs
│   └── system.ts                  # 新：GET/POST /admin-api/admins… + /admin-api/audit-logs
apps/api/test/
├── admin-overview.test.ts         # 新：概览聚合数值
├── admin-users.test.ts            # 新：列表/搜索/封禁/调积分 + 审计 + support 403
├── admin-orders.test.ts           # 新：列表/详情/退款审批 + 审计 + finance/support 权限
├── admin-ledger.test.ts           # 新：流水查询 + 余额=Σ核对
├── admin-plans-configs.test.ts    # 新：plans CRUD + billing_configs 读写即生效 + 审计前后值
└── admin-system.test.ts           # 新：运营账号/角色 CRUD + 审计日志查询 + RBAC
```

> admin-front 前端文件在 `docs/admin-front`（原型，mbp）；本 spec 不改其视觉结构，仅把 6 页的占位数据源切到上述 admin-api 端点（页面 → 端点映射见各 Task「页面接线」段）。

---

## Interfaces

**消费（来自前序 spec，不在本 spec 实现）：**
- spec309（运营后台地基，**真实导出/路径为单一来源**）：
  - `middleware/admin-auth.ts`：`requireAdmin(...roles: AdminRole[]): MiddlewareHandler`（**工厂函数**，roles 空＝任意已认证 admin；校验 admin 会话并注入 `c.var.admin = { id, username, role, status }`；未登录 401、越权 403）；`requirePermission(perm: Permission): MiddlewareHandler`（按角色 RBAC 判定细粒度权限，无权 403）。
  - `services/rbac.ts`：`Permission` 枚举 + `ROLE_PERMISSIONS: Record<AdminRole, Permission[]>` + `hasPermission(role, perm)`。权限名以 spec309 为准：`user.read`/`user.write`/`order.read`/`refund.write`/`ledger.read`/`credit.adjust`/`plan.write`/`config.write`/`referral.write`/`audit.read`/`admin.manage`。
  - `services/audit.ts`：`writeAudit(input: { operator: string; action: string; target?: string; before?: unknown; after?: unknown }): Promise<void>`（落 `admin_audit_logs`）。
  - `services/admin-auth.ts`：`hashPassword(plain): Promise<string>`（Bun.password 哈希，建运营账号用）。
  - 表（`db/schema/admin.ts`）：`adminUsers`、`adminRoles`、`adminSessions`、`adminAuditLogs`；`AdminRole`。
  - > route 层从 `c.get("admin")`（即 `c.var.admin`）取 operator。本 spec 各写接口的 `action`/`perm` 一律引用 spec309 的 `Permission` 枚举值，不自造字符串。
- spec302 账本：`credits.grant(userId, amount, opts)`、`credits.getBalance(userId)`。
- spec306 退款：`createRefund(input, { provider })`、`getPaymentProvider()`（spec304）。
- spec301 配置：`getConfig(key)`、`getConfigs(prefix?)`、`setConfig(key, value)`（**纯写 upsert，无审计**；审计由本 spec 在 route 层显式做）。
- 表（spec301）：`plans`、`subscriptions`、`creditTransactions`、`creditBalances`、`paymentOrders`、`refunds`、`referrals`、`billingConfigs`；C 端 `users`（只读查询，封禁字段见 Task 2）。

**产出（admin-api 端点，供 admin-front 6 页消费）：**

| 页面 | 端点 | 权限(action) |
|---|---|---|
| 概览 | `GET /admin-api/overview` | 任意已登录 |
| 用户 | `GET /admin-api/users`、`GET /admin-api/users/:id`、`POST /admin-api/users/:id/ban`、`POST /admin-api/users/:id/unban`、`POST /admin-api/users/:id/credits` | 读=登录；封禁=`user.write`；调积分=`credit.adjust` |
| 订单 | `GET /admin-api/orders`、`GET /admin-api/orders/:id`、`POST /admin-api/refunds` | 读=登录；退款=`refund.write` |
| 账本 | `GET /admin-api/ledger`、`GET /admin-api/ledger/:userId/check` | 读=登录 |
| 套餐&配置 | `GET /admin-api/plans`、`POST /admin-api/plans`、`PUT /admin-api/plans/:id`、`GET /admin-api/configs`、`PUT /admin-api/configs/:key` | 读=登录；plans 写=`plan.write`；config 写=`config.write` |
| 系统 | `GET /admin-api/admins`、`POST /admin-api/admins`、`PUT /admin-api/admins/:id`、`GET /admin-api/audit-logs` | 账号管理=`admin.manage`（superadmin）；审计查询=`audit.read` |

> 角色→权限映射由 spec309 RBAC 定义（superadmin=全部、ops=用户/套餐/配置、finance=订单/退款/账本、support=只读+工单）。本 spec 各写接口声明所需 `action`，由 `requirePermission` 判定；**support 对任一写 action 均 403**（测试覆盖）。

---

## Task 0: admin-api 路由地基 + RBAC/审计接线骨架

**Files:** Create `apps/api/src/routes/admin/index.ts`；Modify `apps/api/src/app.ts`；Create `apps/api/test/admin-system.test.ts`（先建 RBAC 冒烟壳）

- [ ] **Step 1: 开分支**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout -b phase3/spec310-admin-pages
```

- [ ] **Step 2: 写 `routes/admin/index.ts`（聚合 router + 统一套 requireAdmin）**

```typescript
import { Hono } from "hono";
import { requireAdmin } from "../../middleware/admin-auth"; // spec309
import { overviewRouter } from "./overview";
import { usersRouter } from "./users";
import { ordersRouter } from "./orders";
import { ledgerRouter } from "./ledger";
import { plansRouter } from "./plans";
import { systemRouter } from "./system";

// 所有 admin-api 先过 requireAdmin（登录校验 + c.set("admin")）；各路由内部再 requirePermission(action)
export const adminApiRouter = new Hono();
adminApiRouter.use("*", requireAdmin()); // 工厂函数返回中间件（roles 空＝任意已认证 admin）
adminApiRouter.route("/overview", overviewRouter);
adminApiRouter.route("/users", usersRouter);
adminApiRouter.route("/orders", ordersRouter);
adminApiRouter.route("/ledger", ledgerRouter);
adminApiRouter.route("/plans", plansRouter);   // 含 /configs（见 Task 5）
adminApiRouter.route("/", systemRouter);        // /admins、/audit-logs
```

挂载到主 app：`app.route("/admin-api", adminApiRouter)`（`apps/api/src/app.ts`）。

- [ ] **Step 3: RBAC 冒烟测试 `test/admin-system.test.ts`（先放权限骨架断言）**

```typescript
import { app } from "../src/app";

// 测试夹具：建一个指定角色的 admin 会话，返回可用于请求头的凭证（spec309 提供 makeAdminSession）
// 未就绪前先用 mock：注入 c.set("admin",{role}) 的测试中间件，或直接测 service 层 requirePermission。
test("未登录访问 admin-api → 401", async () => {
  const res = await app.request("/admin-api/overview");
  expect(res.status).toBe(401);
});
```

> spec309 未就绪时，本 Task 仅建路由骨架 + 401 冒烟；RBAC 角色断言（403）在各页 Task 内用 spec309 的会话夹具（`makeAdminSession(role)`）落地。若夹具未就绪，先在 service 层直测 `requirePermission` 判定矩阵（support 写 → 403）。

- [ ] **Step 4: 提交**

```bash
cd apps/api && bun test test/admin-system.test.ts
git add apps/api/src/routes/admin/index.ts apps/api/src/app.ts apps/api/test/admin-system.test.ts
git commit -m "feat(spec310): admin-api 路由地基(adminApiRouter + requireAdmin 统一套 + 401 冒烟)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 1: 概览页（dashboard）—— GET /admin-api/overview

**页面接线：** admin-front「概览」页顶部指标卡 + 趋势区，数据源全部切到 `GET /admin-api/overview`。视觉以原型为准。

**Files:** Create `apps/api/src/services/admin/overview.ts`、`apps/api/src/routes/admin/overview.ts`、`apps/api/test/admin-overview.test.ts`

- [ ] **Step 1: 失败测试 `test/admin-overview.test.ts`**

```typescript
import { computeOverview } from "../src/services/admin/overview";
import { db } from "../src/db";
import { users } from "../src/db/schema/users";
import { subscriptions, plans } from "../src/db/schema/plans";
import { paymentOrders } from "../src/db/schema/payments";
import { creditTransactions } from "../src/db/schema/credits";
import { bidProjects } from "../src/db/schema/projects"; // Phase 2 spec207

test("概览聚合：用户数/付费用户/今日收入/积分流水/活跃项目", async () => {
  const u1 = await makeTestUser();
  const u2 = await makeTestUser();
  // u1 有 active 订阅 → 付费用户 1
  const [plan] = await db.insert(plans).values({ name: "P", billingCycle: "month" }).returning();
  await db.insert(subscriptions).values({ userId: u1, planId: plan.id, status: "active" });
  // 今日 paid 订单 1000 分
  await db.insert(paymentOrders).values({ userId: u1, type: "recharge", amountCents: 1000, status: "paid", provider: "shouqianba", providerTradeNo: "T1", idempotencyKey: "o1" });
  // 积分流水若干
  await db.insert(creditTransactions).values({ userId: u1, type: "grant", amount: 100, idempotencyKey: "c1" });
  // running 标书项目 1 个（spec207）
  await db.insert(bidProjects).values({ userId: u1, status: "running" });

  const o = await computeOverview();
  expect(o.totalUsers).toBeGreaterThanOrEqual(2);
  expect(o.payingUsers).toBeGreaterThanOrEqual(1);
  expect(o.todayRevenueCents).toBeGreaterThanOrEqual(1000);
  expect(o.creditTxCount).toBeGreaterThanOrEqual(1);
  expect(o.activeProjects).toBeGreaterThanOrEqual(1);
});
```

- [ ] **Step 2: 写 `services/admin/overview.ts`**

要点（全部用聚合 SQL，单次往返多查或并行 `Promise.all`）：
- `totalUsers` = `count(users)`；`payingUsers` = `count(distinct subscriptions.user_id where status='active')`。
- `todayRevenueCents` = `sum(payment_orders.amount_cents where status='paid' and created_at >= 今日0点)`。
- `creditTxCount` / `creditTxSumToday` = 今日 `credit_transactions` 笔数 / 净额。
- `activeProjects` = `count(bid_projects where status='running')`（接 Phase 2 `bid_projects` 表，spec207 建；状态枚举以 spec207 为准）。
- 返回 `{ totalUsers, payingUsers, todayRevenueCents, creditTxCount, creditTxSumToday, activeProjects }`。

```typescript
import { db } from "../../db";
import { users } from "../../db/schema/users";
import { subscriptions } from "../../db/schema/plans";
import { paymentOrders } from "../../db/schema/payments";
import { creditTransactions } from "../../db/schema/credits";
import { bidProjects } from "../../db/schema/projects"; // Phase 2 spec207（表名/字段以实际 schema 为准）
import { and, eq, gte, sql } from "drizzle-orm";

export interface OverviewMetrics {
  totalUsers: number; payingUsers: number;
  todayRevenueCents: number; creditTxCount: number; creditTxSumToday: number;
  activeProjects: number;
}

export async function computeOverview(): Promise<OverviewMetrics> {
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const [[u], [p], [rev], [tx], [proj]] = await Promise.all([
    db.select({ n: sql<number>`count(*)` }).from(users),
    db.select({ n: sql<number>`count(distinct ${subscriptions.userId})` }).from(subscriptions).where(eq(subscriptions.status, "active")),
    db.select({ s: sql<number>`coalesce(sum(${paymentOrders.amountCents}),0)` }).from(paymentOrders).where(and(eq(paymentOrders.status, "paid"), gte(paymentOrders.createdAt, todayStart))),
    db.select({ c: sql<number>`count(*)`, s: sql<number>`coalesce(sum(${creditTransactions.amount}),0)` }).from(creditTransactions).where(gte(creditTransactions.createdAt, todayStart)),
    // activeProjects：接 Phase 2 bid_projects 表 count(status='running')（spec207）
    db.select({ n: sql<number>`count(*)` }).from(bidProjects).where(eq(bidProjects.status, "running")),
  ]);
  return {
    totalUsers: Number(u.n), payingUsers: Number(p.n),
    todayRevenueCents: Number(rev.s), creditTxCount: Number(tx.c), creditTxSumToday: Number(tx.s),
    activeProjects: Number(proj.n),
  };
}
```

- [ ] **Step 3: 写 `routes/admin/overview.ts`**

```typescript
import { Hono } from "hono";
import { computeOverview } from "../../services/admin/overview";

export const overviewRouter = new Hono();
// 读接口：requireAdmin 已在聚合层套，任意角色可读
overviewRouter.get("/", async (c) => c.json(await computeOverview()));
```

- [ ] **Step 4: 通过 + 提交**

```bash
cd apps/api && bun test test/admin-overview.test.ts
git add apps/api/src/services/admin/overview.ts apps/api/src/routes/admin/overview.ts apps/api/test/admin-overview.test.ts
git commit -m "feat(spec310): 概览页 GET /admin-api/overview(关键指标聚合)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 用户页（users）—— 列表/搜索/详情/封禁解封/手动调积分

**页面接线：** admin-front「users」页：列表（搜索框 + 分页）→ `GET /admin-api/users?q=&page=`；详情抽屉 → `GET /admin-api/users/:id`；封禁/解封按钮 → `POST …/ban`、`…/unban`；调积分弹窗 → `POST …/credits`。视觉以原型为准。

> 封禁字段：C 端 `users` 若无 `status`/`banned_at`，本 Task 在 `users` schema 加 `status text default 'active'`（active/banned）+ 迁移；封禁=置 `banned`、解封=置 `active`。

**Files:** Create `apps/api/src/services/admin/admin-users.ts`、`apps/api/src/routes/admin/users.ts`、`apps/api/test/admin-users.test.ts`；Modify `apps/api/src/db/schema/users.ts`（加 status）+ 迁移

- [ ] **Step 1: 给 `users` 加 `status`（若无）+ 迁移**

```typescript
// users.ts 加：status: text("status").notNull().default("active"), // active/banned
```
```bash
cd apps/api && bun run drizzle-kit generate
```

- [ ] **Step 2: 失败测试 `test/admin-users.test.ts`（列表/搜索/封禁/调积分 + 审计 + support 403）**

```typescript
import { listUsers, getUserDetail, banUser, unbanUser, adminGrantCredits } from "../src/services/admin/admin-users";
import { db } from "../src/db";
import { users } from "../src/db/schema/users";
import { creditTransactions } from "../src/db/schema/credits";
import { adminAuditLogs } from "../src/db/schema/admin"; // spec309
import { eq } from "drizzle-orm";

test("列表 + 关键字搜索 + 分页", async () => {
  const a = await makeTestUser({ email: "alice@x.com" });
  await makeTestUser({ email: "bob@x.com" });
  const r = await listUsers({ q: "alice", page: 1, pageSize: 10 });
  expect(r.total).toBe(1);
  expect(r.items[0].id).toBe(a);
});

test("封禁/解封 + 审计前后值", async () => {
  const u = await makeTestUser();
  await banUser(u, { operator: "ops_alice" });
  const [row] = await db.select().from(users).where(eq(users.id, u));
  expect(row.status).toBe("banned");
  const logs = await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.action, "user.write"));
  expect(logs.length).toBeGreaterThanOrEqual(1);
  expect((logs.at(-1) as any).before).toMatchObject({ status: "active" });
  expect((logs.at(-1) as any).after).toMatchObject({ status: "banned" });
  await unbanUser(u, { operator: "ops_alice" });
  const [row2] = await db.select().from(users).where(eq(users.id, u));
  expect(row2.status).toBe("active");
});

test("手动调积分：写 credits.grant + 审计", async () => {
  const u = await makeTestUser();
  const res = await adminGrantCredits(u, { amount: 200, reason: "补偿", operator: "ops_alice", adminId: "adm1" });
  expect(res.balance).toBe(200);
  const txs = await db.select().from(creditTransactions).where(eq(creditTransactions.userId, u));
  expect(txs.some((t) => t.amount === 200 && t.type === "grant")).toBe(true);
  const logs = await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.action, "credit.adjust"));
  expect(logs.length).toBeGreaterThanOrEqual(1);
});

test("手动扣积分（负向）也走 grant + 审计", async () => {
  const u = await makeTestUser();
  await adminGrantCredits(u, { amount: 100, reason: "init", operator: "ops", adminId: "adm1" });
  const res = await adminGrantCredits(u, { amount: -30, reason: "扣回", operator: "ops", adminId: "adm1" });
  expect(res.balance).toBe(70);
});

// RBAC：support 角色对写操作 403（route 层经 requirePermission）
test("support 调用封禁路由 → 403", async () => {
  const { app } = await import("../src/app");
  const u = await makeTestUser();
  const res = await app.request(`/admin-api/users/${u}/ban`, {
    method: "POST",
    headers: makeAdminSession("support"),       // spec309 夹具：support 会话头
  });
  expect(res.status).toBe(403);
});
```

- [ ] **Step 3: 写 `services/admin/admin-users.ts`**

要点：
- `listUsers({ q?, page, pageSize })`：`q` 模糊匹配 email/手机/昵称（`ilike`）；返回 `{ items, total, page, pageSize }`（items 含 id/email/status/createdAt/balance 概要）。
- `getUserDetail(id)`：用户基本信息 + 当前订阅（join `subscriptions`+`plans`）+ 余额（`credits.getBalance`）+ 近 N 笔订单/流水概要。
- `banUser(id, {operator})` / `unbanUser(id, {operator})`：读旧 status → 更新 → `writeAudit({ operator, action:"user.write", target:`user:${id}`, before:{status}, after:{status} })`（封禁/解封同属 `user.write` 权限）。
- `adminGrantCredits(id, { amount, reason, operator, adminId })`：调 spec302 `credits.grant(id, amount, { type:"grant", ref:`admin:${reason}`, idempotencyKey:`admin:${adminId}:${Date.now()}` })`（负向 amount 即扣减）→ `getBalance` → `writeAudit({ action:"credit.adjust", target:`user:${id}`, before:{balance:旧}, after:{balance:新, amount, reason} })`。返回 `{ balance }`。

```typescript
import { db } from "../../db";
import { users } from "../../db/schema/users";
import { subscriptions, plans } from "../../db/schema/plans";
import { grant, getBalance } from "../../services/credits";
import { writeAudit } from "../../services/audit"; // spec309
import { and, eq, ilike, or, sql } from "drizzle-orm";

export async function listUsers(opts: { q?: string; page?: number; pageSize?: number }) {
  const page = opts.page ?? 1, pageSize = opts.pageSize ?? 20;
  const where = opts.q ? or(ilike(users.email, `%${opts.q}%`)) : undefined;
  const [items, [cnt]] = await Promise.all([
    db.select().from(users).where(where).limit(pageSize).offset((page - 1) * pageSize).orderBy(users.createdAt),
    db.select({ n: sql<number>`count(*)` }).from(users).where(where),
  ]);
  return { items, total: Number(cnt.n), page, pageSize };
}

export async function getUserDetail(id: string) {
  const [u] = await db.select().from(users).where(eq(users.id, id));
  if (!u) throw new Error("用户不存在");
  const [sub] = await db.select().from(subscriptions).where(and(eq(subscriptions.userId, id), eq(subscriptions.status, "active")));
  const balance = await getBalance(id);
  return { ...u, subscription: sub ?? null, balance };
}

export async function banUser(id: string, opts: { operator: string }) {
  const [u] = await db.select().from(users).where(eq(users.id, id));
  if (!u) throw new Error("用户不存在");
  await db.update(users).set({ status: "banned" }).where(eq(users.id, id));
  await writeAudit({ operator: opts.operator, action: "user.write", target: `user:${id}`, before: { status: u.status }, after: { status: "banned" } });
}

export async function unbanUser(id: string, opts: { operator: string }) {
  const [u] = await db.select().from(users).where(eq(users.id, id));
  if (!u) throw new Error("用户不存在");
  await db.update(users).set({ status: "active" }).where(eq(users.id, id));
  await writeAudit({ operator: opts.operator, action: "user.write", target: `user:${id}`, before: { status: u.status }, after: { status: "active" } });
}

export async function adminGrantCredits(id: string, opts: { amount: number; reason: string; operator: string; adminId: string }) {
  const before = await getBalance(id);
  await grant(id, opts.amount, { type: "grant", ref: `admin:${opts.reason}`, idempotencyKey: `admin:${opts.adminId}:${Date.now()}` });
  const after = await getBalance(id);
  await writeAudit({ operator: opts.operator, action: "credit.adjust", target: `user:${id}`, before: { balance: before }, after: { balance: after, amount: opts.amount, reason: opts.reason } });
  return { balance: after };
}
```

- [ ] **Step 4: 写 `routes/admin/users.ts`（含 requirePermission）**

```typescript
import { Hono } from "hono";
import { z } from "zod";
import { requirePermission } from "../../middleware/admin-auth"; // spec309
import { listUsers, getUserDetail, banUser, unbanUser, adminGrantCredits } from "../../services/admin/admin-users";

export const usersRouter = new Hono();

usersRouter.get("/", async (c) => {
  const q = c.req.query("q") || undefined;
  const page = Number(c.req.query("page") ?? 1), pageSize = Number(c.req.query("pageSize") ?? 20);
  return c.json(await listUsers({ q, page, pageSize }));
});
usersRouter.get("/:id", async (c) => c.json(await getUserDetail(c.req.param("id"))));

usersRouter.post("/:id/ban", requirePermission("user.write"), async (c) => {
  const admin = c.get("admin");
  await banUser(c.req.param("id"), { operator: admin.username });
  return c.json({ ok: true });
});
usersRouter.post("/:id/unban", requirePermission("user.write"), async (c) => {
  const admin = c.get("admin");
  await unbanUser(c.req.param("id"), { operator: admin.username });
  return c.json({ ok: true });
});

const GrantBody = z.object({ amount: z.number().int(), reason: z.string().min(1) });
usersRouter.post("/:id/credits", requirePermission("credit.adjust"), async (c) => {
  const admin = c.get("admin");
  const parsed = GrantBody.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const res = await adminGrantCredits(c.req.param("id"), { ...parsed.data, operator: admin.username, adminId: admin.id });
  return c.json(res);
});
```

- [ ] **Step 5: 通过 + 提交**

```bash
cd apps/api && bun test test/admin-users.test.ts
git add apps/api/src/services/admin/admin-users.ts apps/api/src/routes/admin/users.ts apps/api/src/db/schema/users.ts apps/api/drizzle apps/api/test/admin-users.test.ts
git commit -m "feat(spec310): 用户页(列表/搜索/详情/封禁解封/手动调积分 → credits.grant + 审计 + RBAC)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 订单页（orders）—— 列表/详情/退款审批

**页面接线：** admin-front「orders」页：订单表（状态/类型过滤 + 分页）→ `GET /admin-api/orders`；详情 → `GET /admin-api/orders/:id`（含关联退款记录）；退款审批弹窗 → `POST /admin-api/refunds`（走 spec306）。视觉以原型为准。

**Files:** Create `apps/api/src/services/admin/admin-orders.ts`、`apps/api/src/routes/admin/orders.ts`、`apps/api/test/admin-orders.test.ts`

- [ ] **Step 1: 失败测试 `test/admin-orders.test.ts`（列表/详情/退款审批 + 审计 + 权限）**

```typescript
import { listOrders, getOrderDetail } from "../src/services/admin/admin-orders";
import { db } from "../src/db";
import { paymentOrders, refunds } from "../src/db/schema/payments";
import { adminAuditLogs } from "../src/db/schema/admin";
import { eq } from "drizzle-orm";

test("订单列表 + 状态过滤 + 分页", async () => {
  const u = await makeTestUser();
  await db.insert(paymentOrders).values({ userId: u, type: "recharge", amountCents: 1000, status: "paid", provider: "shouqianba", providerTradeNo: "T1", idempotencyKey: "o1" });
  await db.insert(paymentOrders).values({ userId: u, type: "recharge", amountCents: 500, status: "created", provider: "shouqianba", providerTradeNo: "T2", idempotencyKey: "o2" });
  const r = await listOrders({ status: "paid", page: 1, pageSize: 10 });
  expect(r.items.every((o) => o.status === "paid")).toBe(true);
  expect(r.total).toBeGreaterThanOrEqual(1);
});

test("订单详情含关联退款", async () => {
  const u = await makeTestUser();
  const [o] = await db.insert(paymentOrders).values({ userId: u, type: "recharge", amountCents: 1000, status: "refunded", provider: "shouqianba", providerTradeNo: "T3", idempotencyKey: "o3" }).returning();
  await db.insert(refunds).values({ orderId: o.id, amountCents: 1000, status: "done", operator: "ops" });
  const d = await getOrderDetail(o.id);
  expect(d.refunds.length).toBe(1);
});

// 退款审批（route 层走 spec306 createRefund + 审计 + 权限）
test("finance 发起退款 → done + 审计；support → 403", async () => {
  const { app } = await import("../src/app");
  const u = await makeTestUser();
  const [o] = await db.insert(paymentOrders).values({ userId: u, type: "recharge", amountCents: 1000, status: "paid", provider: "shouqianba", providerTradeNo: "T4", idempotencyKey: "o4" }).returning();

  const ok = await app.request("/admin-api/refunds", {
    method: "POST", headers: { ...makeAdminSession("finance"), "content-type": "application/json" },
    body: JSON.stringify({ orderId: o.id, amount: 1000, reason: "用户申请" }),
  });
  expect(ok.status).toBe(200);
  expect((await ok.json()).status).toBe("done");
  const logs = await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.action, "refund.write"));
  expect(logs.length).toBeGreaterThanOrEqual(1);

  const denied = await app.request("/admin-api/refunds", {
    method: "POST", headers: { ...makeAdminSession("support"), "content-type": "application/json" },
    body: JSON.stringify({ orderId: o.id, amount: 1, reason: "x" }),
  });
  expect(denied.status).toBe(403);
});
```

> 退款 provider 在测试注入 mock（`getPaymentProvider` 可覆盖 / 测试环境返回 okProvider），同 spec306 约定。

- [ ] **Step 2: 写 `services/admin/admin-orders.ts`**

要点：
- `listOrders({ status?, type?, userId?, q?, page, pageSize })`：按条件过滤，`{ items, total, page, pageSize }`，items 含订单 + user 概要。
- `getOrderDetail(id)`：订单 + 关联 `refunds`（按 orderId）+ user 概要。

```typescript
import { db } from "../../db";
import { paymentOrders, refunds } from "../../db/schema/payments";
import { and, eq, sql, type SQL } from "drizzle-orm";

export async function listOrders(opts: { status?: string; type?: string; userId?: string; page?: number; pageSize?: number }) {
  const page = opts.page ?? 1, pageSize = opts.pageSize ?? 20;
  const conds: SQL[] = [];
  if (opts.status) conds.push(eq(paymentOrders.status, opts.status));
  if (opts.type) conds.push(eq(paymentOrders.type, opts.type));
  if (opts.userId) conds.push(eq(paymentOrders.userId, opts.userId));
  const where = conds.length ? and(...conds) : undefined;
  const [items, [cnt]] = await Promise.all([
    db.select().from(paymentOrders).where(where).limit(pageSize).offset((page - 1) * pageSize).orderBy(paymentOrders.createdAt),
    db.select({ n: sql<number>`count(*)` }).from(paymentOrders).where(where),
  ]);
  return { items, total: Number(cnt.n), page, pageSize };
}

export async function getOrderDetail(id: string) {
  const [o] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, id));
  if (!o) throw new Error("订单不存在");
  const rs = await db.select().from(refunds).where(eq(refunds.orderId, id));
  return { ...o, refunds: rs };
}
```

- [ ] **Step 3: 写 `routes/admin/orders.ts`（列表/详情 + 退款审批包 spec306 + 审计）**

```typescript
import { Hono } from "hono";
import { z } from "zod";
import { requirePermission } from "../../middleware/admin-auth"; // spec309
import { writeAudit } from "../../services/audit"; // spec309
import { listOrders, getOrderDetail } from "../../services/admin/admin-orders";
import { createRefund } from "../../services/refunds";          // spec306
import { getPaymentProvider } from "../../services/payment";     // spec304

export const ordersRouter = new Hono();

ordersRouter.get("/", async (c) => {
  return c.json(await listOrders({
    status: c.req.query("status") || undefined,
    type: c.req.query("type") || undefined,
    userId: c.req.query("userId") || undefined,
    page: Number(c.req.query("page") ?? 1), pageSize: Number(c.req.query("pageSize") ?? 20),
  }));
});
ordersRouter.get("/:id", async (c) => c.json(await getOrderDetail(c.req.param("id"))));

// 退款审批：单独挂在聚合层 /admin-api/refunds（见 index.ts），权限 refund.write
const RefundBody = z.object({ orderId: z.string().uuid(), amount: z.number().int().positive(), reason: z.string().min(1) });
export const refundsRouter = new Hono();
refundsRouter.post("/", requirePermission("refund.write"), async (c) => {
  const admin = c.get("admin");
  const parsed = RefundBody.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  try {
    const res = await createRefund(
      { orderId: parsed.data.orderId, amountCents: parsed.data.amount, reason: parsed.data.reason, operator: admin.username },
      { provider: getPaymentProvider() },
    );
    await writeAudit({ operator: admin.username, action: "refund.write", target: `order:${parsed.data.orderId}`, before: { status: "paid" }, after: { refundId: res.refundId, status: res.status, amountCents: parsed.data.amount } });
    return c.json(res);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 422);
  }
});
```

> 在 `routes/admin/index.ts` 加：`import { refundsRouter } from "./orders"; adminApiRouter.route("/refunds", refundsRouter);`。**退款唯一入口收口为本 spec 的 `POST /admin-api/refunds`**（spec306 已删自建路由，只保留 `createRefund` service）：本路由过 `requireAdmin()`（聚合层）+ `requirePermission("refund.write")` + `writeAudit({action:"refund.write"})`，再调 spec306 `createRefund`。退款审计在 admin-api 层显式补写真实 `writeAudit`（spec306 service 内若有 `auditLog` 占位由此替换/叠加，二者不冲突）。

- [ ] **Step 4: 通过 + 提交**

```bash
cd apps/api && bun test test/admin-orders.test.ts
git add apps/api/src/services/admin/admin-orders.ts apps/api/src/routes/admin/orders.ts apps/api/src/routes/admin/index.ts apps/api/test/admin-orders.test.ts
git commit -m "feat(spec310): 订单页(列表/详情/退款审批 → spec306 createRefund + 审计 + finance/support RBAC)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 账本页（ledger）—— 流水查询 + 余额=Σ流水核对

**页面接线：** admin-front「ledger」页：按用户查流水（type 过滤 + 分页）→ `GET /admin-api/ledger?userId=&type=`；余额核对卡 → `GET /admin-api/ledger/:userId/check`（缓存余额 vs Σ流水）。视觉以原型为准。

**Files:** Create `apps/api/src/services/admin/ledger.ts`、`apps/api/src/routes/admin/ledger.ts`、`apps/api/test/admin-ledger.test.ts`

- [ ] **Step 1: 失败测试 `test/admin-ledger.test.ts`**

```typescript
import { listLedger, checkBalance } from "../src/services/admin/ledger";
import { db } from "../src/db";
import { creditTransactions, creditBalances } from "../src/db/schema/credits";

test("按用户查流水 + type 过滤 + 分页", async () => {
  const u = await makeTestUser();
  await db.insert(creditTransactions).values({ userId: u, type: "grant", amount: 100, idempotencyKey: "l1" });
  await db.insert(creditTransactions).values({ userId: u, type: "hold", amount: -10, idempotencyKey: "l2" });
  const all = await listLedger({ userId: u, page: 1, pageSize: 50 });
  expect(all.total).toBe(2);
  const onlyHold = await listLedger({ userId: u, type: "hold", page: 1, pageSize: 50 });
  expect(onlyHold.items.every((t) => t.type === "hold")).toBe(true);
});

test("余额核对：缓存 vs Σ流水（一致/不一致）", async () => {
  const u = await makeTestUser();
  await db.insert(creditTransactions).values({ userId: u, type: "grant", amount: 100, idempotencyKey: "l3" });
  await db.insert(creditBalances).values({ userId: u, balance: 100 });
  const ok = await checkBalance(u);
  expect(ok).toEqual({ userId: u, cached: 100, actual: 100, consistent: true });

  await db.update(creditBalances).set({ balance: 80 }).where(eq(creditBalances.userId, u));
  const bad = await checkBalance(u);
  expect(bad.consistent).toBe(false);
  expect(bad.actual).toBe(100);
});
```

- [ ] **Step 2: 写 `services/admin/ledger.ts`**

```typescript
import { db } from "../../db";
import { creditTransactions, creditBalances } from "../../db/schema/credits";
import { and, eq, sql, type SQL } from "drizzle-orm";

export async function listLedger(opts: { userId: string; type?: string; page?: number; pageSize?: number }) {
  const page = opts.page ?? 1, pageSize = opts.pageSize ?? 20;
  const conds: SQL[] = [eq(creditTransactions.userId, opts.userId)];
  if (opts.type) conds.push(eq(creditTransactions.type, opts.type));
  const where = and(...conds);
  const [items, [cnt]] = await Promise.all([
    db.select().from(creditTransactions).where(where).limit(pageSize).offset((page - 1) * pageSize).orderBy(creditTransactions.createdAt),
    db.select({ n: sql<number>`count(*)` }).from(creditTransactions).where(where),
  ]);
  return { items, total: Number(cnt.n), page, pageSize };
}

// 余额核对：缓存 vs Σ流水（账本审计单用户版，复用 spec306 思路）
export async function checkBalance(userId: string) {
  const [s] = await db.select({ actual: sql<number>`coalesce(sum(${creditTransactions.amount}),0)` })
    .from(creditTransactions).where(eq(creditTransactions.userId, userId));
  const [b] = await db.select().from(creditBalances).where(eq(creditBalances.userId, userId));
  const actual = Number(s?.actual ?? 0), cached = b?.balance ?? 0;
  return { userId, cached, actual, consistent: cached === actual };
}
```

- [ ] **Step 3: 写 `routes/admin/ledger.ts`（只读，登录即可）**

```typescript
import { Hono } from "hono";
import { listLedger, checkBalance } from "../../services/admin/ledger";

export const ledgerRouter = new Hono();
ledgerRouter.get("/", async (c) => {
  const userId = c.req.query("userId");
  if (!userId) return c.json({ error: "userId 必填" }, 400);
  return c.json(await listLedger({ userId, type: c.req.query("type") || undefined, page: Number(c.req.query("page") ?? 1), pageSize: Number(c.req.query("pageSize") ?? 20) }));
});
ledgerRouter.get("/:userId/check", async (c) => c.json(await checkBalance(c.req.param("userId"))));
```

- [ ] **Step 4: 通过 + 提交**

```bash
cd apps/api && bun test test/admin-ledger.test.ts
git add apps/api/src/services/admin/ledger.ts apps/api/src/routes/admin/ledger.ts apps/api/test/admin-ledger.test.ts
git commit -m "feat(spec310): 账本页(流水查询 + 余额=Σ流水核对)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 套餐&配置页（plans）—— plans CRUD + billing_configs 可视化管理

**页面接线：** admin-front「plans」页分两区：①套餐区（列表 + 新建/编辑/上下架/改价）→ `GET /admin-api/plans`、`POST /admin-api/plans`、`PUT /admin-api/plans/:id`；②配置区（积分口径 `credit_cost.*` / 充值包 `recharge_packs` / 汇率 `credit_rate` / 有效期 `grant_expire_days` / 推荐规则 `referral_rules` / 到期提醒档 `renewal_reminder_days` / 宽限期 `renewal_grace_days` / 支付轮询 `payment_poll`，**读写同一张 `billing_configs`**）→ `GET /admin-api/configs`、`PUT /admin-api/configs/:key`。视觉以原型为准。

**关键：改 `billing_configs` 写库 + `getConfig` 立即读到新值（无缓存）+ 审计留前后值。**

**Files:** Create `apps/api/src/services/admin/admin-plans.ts`、`apps/api/src/routes/admin/plans.ts`、`apps/api/test/admin-plans-configs.test.ts`（**不改 `services/config.ts`**：直接消费 spec301 的 `getConfig/getConfigs/setConfig`）

- [ ] **Step 1: 确认 spec301 的 `setConfig(key, value)` 纯写契约（本 spec 不重定义、不加审计）**

spec301 已提供 `setConfig(key, value)`：upsert 同一张 `billing_configs`，纯写、无审计、无缓存层。本 spec **不再在 `services/config.ts` 重定义三参 `setConfig(key, value, { operator })`**，而是直接消费，并把审计放到 route 层（Step 4）。

```typescript
// spec301 现状（仅引用，不在本 spec 修改）：
// export async function setConfig(key: string, value: unknown): Promise<void> {
//   await db.insert(billingConfigs).values({ key, value })
//     .onConflictDoUpdate({ target: billingConfigs.key, set: { value, updatedAt: new Date() } });
// }
```

> `getConfig` 直接查库（spec301 实现），无内存缓存 → `setConfig` 后立即生效（账本 `hold` 读 `credit_cost.<op>` 即用新口径）。若后续引入缓存，须在 `setConfig` 失效该 key。审计前后值由 route 层显式记录（见 Step 4）。

- [ ] **Step 2: 失败测试 `test/admin-plans-configs.test.ts`**

```typescript
import { setConfig, getConfig } from "../src/services/config";
import { listPlans, createPlan, updatePlan } from "../src/services/admin/admin-plans";
import { db } from "../src/db";
import { plans } from "../src/db/schema/plans";
import { adminAuditLogs } from "../src/db/schema/admin";
import { eq } from "drizzle-orm";

test("改 billing_config：setConfig 纯写 + getConfig 立即读到新值（无缓存）", async () => {
  await setConfig("credit_cost.read", 10);
  expect(await getConfig("credit_cost.read")).toBe(10);
  await setConfig("credit_cost.read", 25);
  expect(await getConfig("credit_cost.read")).toBe(25);        // 立即生效
});

test("config 审计在 route 层：PUT /admin-api/configs/:key 留前后值", async () => {
  const { app } = await import("../src/app");
  await setConfig("credit_cost.read", 10);                      // 预置旧值
  const res = await app.request("/admin-api/plans/configs/credit_cost.read", {
    method: "PUT", headers: { ...makeAdminSession("ops"), "content-type": "application/json" },
    body: JSON.stringify({ value: 25 }),
  });
  expect(res.status).toBe(200);
  expect(await getConfig("credit_cost.read")).toBe(25);        // 立即生效
  const logs = await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.action, "config.write"));
  const last = logs.at(-1) as any;
  expect(last.before).toBe(10);
  expect(last.after).toBe(25);
});

test("充值包/推荐规则等复杂配置整体替换", async () => {
  await setConfig("recharge_packs", [{ amountCents: 100, credits: 100 }]);
  await setConfig("recharge_packs", [{ amountCents: 1000, credits: 1200 }]);
  expect(await getConfig("recharge_packs")).toEqual([{ amountCents: 1000, credits: 1200 }]);
});

test("plans CRUD：新建/改价/下架 + 审计", async () => {
  const p = await createPlan({ name: "专业版", priceCents: 2900, billingCycle: "month", grantCreditsPerCycle: 1000 }, { operator: "ops_alice" });
  expect(p.priceCents).toBe(2900);
  const upd = await updatePlan(p.id, { priceCents: 1900, status: "archived" }, { operator: "ops_alice" });
  expect(upd.priceCents).toBe(1900);
  expect(upd.status).toBe("archived");
  const logs = await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.action, "plan.write"));
  expect(logs.length).toBeGreaterThanOrEqual(1);
});

// RBAC：support 改配置 / 改套餐 → 403
test("support 改配置 → 403；support 改套餐 → 403", async () => {
  const { app } = await import("../src/app");
  const cfg = await app.request("/admin-api/configs/credit_cost.read", {
    method: "PUT", headers: { ...makeAdminSession("support"), "content-type": "application/json" },
    body: JSON.stringify({ value: 99 }),
  });
  expect(cfg.status).toBe(403);
  const pl = await app.request("/admin-api/plans", {
    method: "POST", headers: { ...makeAdminSession("support"), "content-type": "application/json" },
    body: JSON.stringify({ name: "x", billingCycle: "month" }),
  });
  expect(pl.status).toBe(403);
});
```

- [ ] **Step 3: 写 `services/admin/admin-plans.ts`（plans CRUD + 审计）**

```typescript
import { db } from "../../db";
import { plans } from "../../db/schema/plans";
import { writeAudit } from "../../services/audit"; // spec309
import { eq } from "drizzle-orm";

export async function listPlans() {
  return db.select().from(plans).orderBy(plans.createdAt);
}

export async function createPlan(input: { name: string; priceCents?: number; currency?: string; billingCycle: string; grantCreditsPerCycle?: number; features?: Record<string, unknown>; limits?: Record<string, unknown> }, opts: { operator: string }) {
  const [p] = await db.insert(plans).values({ ...input }).returning();
  await writeAudit({ operator: opts.operator, action: "plan.write", target: `plan:${p.id}`, before: null, after: p });
  return p;
}

export async function updatePlan(id: string, patch: Partial<{ priceCents: number; grantCreditsPerCycle: number; status: string; features: Record<string, unknown>; limits: Record<string, unknown> }>, opts: { operator: string }) {
  const [before] = await db.select().from(plans).where(eq(plans.id, id));
  if (!before) throw new Error("套餐不存在");
  // 改价/改权益时 version 自增，避免历史订阅口径错乱
  const nextVersion = (before.version ?? 1) + (patch.priceCents !== undefined || patch.grantCreditsPerCycle !== undefined ? 1 : 0);
  const [after] = await db.update(plans).set({ ...patch, version: nextVersion }).where(eq(plans.id, id)).returning();
  await writeAudit({ operator: opts.operator, action: "plan.write", target: `plan:${id}`, before, after });
  return after;
}
```

- [ ] **Step 4: 写 `routes/admin/plans.ts`（plans 写=plan.write；configs 写=config.write）**

```typescript
import { Hono } from "hono";
import { z } from "zod";
import { requirePermission } from "../../middleware/admin-auth"; // spec309
import { writeAudit } from "../../services/audit"; // spec309
import { listPlans, createPlan, updatePlan } from "../../services/admin/admin-plans";
import { getConfig, getConfigs, setConfig } from "../../services/config"; // spec301

export const plansRouter = new Hono();

// 套餐
plansRouter.get("/", async (c) => c.json(await listPlans()));
const CreateBody = z.object({ name: z.string().min(1), priceCents: z.number().int().nonnegative().optional(), currency: z.string().optional(), billingCycle: z.string().min(1), grantCreditsPerCycle: z.number().int().nonnegative().optional(), features: z.record(z.unknown()).optional(), limits: z.record(z.unknown()).optional() });
plansRouter.post("/", requirePermission("plan.write"), async (c) => {
  const admin = c.get("admin");
  const parsed = CreateBody.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  return c.json(await createPlan(parsed.data, { operator: admin.username }));
});
const UpdateBody = z.object({ priceCents: z.number().int().nonnegative().optional(), grantCreditsPerCycle: z.number().int().nonnegative().optional(), status: z.enum(["active", "archived"]).optional(), features: z.record(z.unknown()).optional(), limits: z.record(z.unknown()).optional() });
plansRouter.put("/:id", requirePermission("plan.write"), async (c) => {
  const admin = c.get("admin");
  const parsed = UpdateBody.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  return c.json(await updatePlan(c.req.param("id"), parsed.data, { operator: admin.username }));
});

// 配置（同一张 billing_configs；GET 全量 / PUT 单 key）—— 挂在 plansRouter 下的 /configs 子路径
const ConfigBody = z.object({ value: z.unknown() });
plansRouter.get("/configs", async (c) => c.json(await getConfigs(c.req.query("prefix") || undefined)));
plansRouter.put("/configs/:key", requirePermission("config.write"), async (c) => {
  const admin = c.get("admin");
  const key = c.req.param("key");
  const parsed = ConfigBody.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  // 审计在 route 层显式做：读旧值 → 纯写 setConfig(key,value) → writeAudit 留前后值
  const before = await getConfig(key);
  await setConfig(key, parsed.data.value);
  await writeAudit({ operator: admin.username, action: "config.write", target: `config:${key}`, before, after: parsed.data.value });
  return c.json({ ok: true });
});
```

> 端点对外是 `GET /admin-api/plans/configs`、`PUT /admin-api/plans/configs/:key`；若原型要求 `/admin-api/configs` 平级，在 `index.ts` 用单独 `configsRouter` 挂 `adminApiRouter.route("/configs", configsRouter)`（与 plans 同 service，互不影响）。两种挂法择一，落地按 admin-front 实际请求路径对齐。

- [ ] **Step 5: 通过 + 提交**

```bash
cd apps/api && bun test test/admin-plans-configs.test.ts
git add apps/api/src/services/config.ts apps/api/src/services/admin/admin-plans.ts apps/api/src/routes/admin/plans.ts apps/api/test/admin-plans-configs.test.ts
git commit -m "feat(spec310): 套餐&配置页(plans CRUD + billing_configs 可视化管理 setConfig 即生效 + 审计前后值 + RBAC)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 系统页（system）—— 运营账号/角色管理 + 审计日志查询

**页面接线：** admin-front「system」页分两区：①运营账号区（列表 + 新建/改角色/停用）→ `GET /admin-api/admins`、`POST /admin-api/admins`、`PUT /admin-api/admins/:id`（权限 `admin.manage`，仅 superadmin）；②审计日志区（按操作人/动作/时间过滤 + 分页）→ `GET /admin-api/audit-logs`（权限 `audit.read`）。视觉以原型为准。

**Files:** Create `apps/api/src/services/admin/admin-accounts.ts`、`apps/api/src/routes/admin/system.ts`；Modify `apps/api/test/admin-system.test.ts`

- [ ] **Step 1: 失败测试（在 `test/admin-system.test.ts` 加）**

```typescript
import { listAdmins, createAdmin, updateAdmin, listAuditLogs } from "../src/services/admin/admin-accounts";
import { db } from "../src/db";
import { adminUsers, adminAuditLogs } from "../src/db/schema/admin";
import { eq } from "drizzle-orm";

test("运营账号 CRUD + 改角色走审计", async () => {
  const a = await createAdmin({ username: "ops_new", role: "ops", password: "pw123456" }, { operator: "superadmin_root" });
  expect(a.username).toBe("ops_new");
  const upd = await updateAdmin(a.id, { role: "finance", status: "disabled" }, { operator: "superadmin_root" });
  expect(upd.role).toBe("finance");
  expect(upd.status).toBe("disabled");
  const logs = await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.action, "admin.manage"));
  expect(logs.length).toBeGreaterThanOrEqual(1);
});

test("审计日志查询：按动作/操作人过滤 + 分页", async () => {
  // 先制造若干审计（如改配置/封禁）
  const r = await listAuditLogs({ action: "admin.manage", page: 1, pageSize: 50 });
  expect(r.items.every((l) => l.action === "admin.manage")).toBe(true);
  expect(typeof r.total).toBe("number");
});

// RBAC：非 superadmin 管账号 → 403；非 audit.read 角色查日志按 RBAC 判定
test("ops 管理运营账号 → 403（仅 superadmin）", async () => {
  const { app } = await import("../src/app");
  const res = await app.request("/admin-api/admins", {
    method: "POST", headers: { ...makeAdminSession("ops"), "content-type": "application/json" },
    body: JSON.stringify({ username: "x", role: "support", password: "pw123456" }),
  });
  expect(res.status).toBe(403);
});
```

- [ ] **Step 2: 写 `services/admin/admin-accounts.ts`**

要点（`admin_users`/`admin_audit_logs` 表来自 spec309）：
- `listAdmins({ page, pageSize })`：分页列出运营账号（不返回密码 hash）。
- `createAdmin({ username, role, password }, {operator})`：哈希密码（复用 spec309 `services/admin-auth` 的 `hashPassword`）→ 插入 `admin_users` → `writeAudit({ action:"admin.manage", target:`admin:${id}`, before:null, after:{username, role} })`。
- `updateAdmin(id, { role?, status? }, {operator})`：读旧值 → 更新 → 审计（before/after 角色与状态）。
- `listAuditLogs({ operator?, action?, from?, to?, page, pageSize })`：查询 `admin_audit_logs`，按条件过滤 + 分页，倒序。

```typescript
import { db } from "../../db";
import { adminUsers, adminAuditLogs } from "../../db/schema/admin"; // spec309
import { writeAudit } from "../../services/audit"; // spec309
import { hashPassword } from "../../services/admin-auth"; // spec309（密码哈希工具）
import { and, eq, gte, lte, sql, type SQL } from "drizzle-orm";

export async function listAdmins(opts: { page?: number; pageSize?: number }) {
  const page = opts.page ?? 1, pageSize = opts.pageSize ?? 20;
  const [items, [cnt]] = await Promise.all([
    db.select({ id: adminUsers.id, username: adminUsers.username, role: adminUsers.role, status: adminUsers.status, createdAt: adminUsers.createdAt }).from(adminUsers).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)` }).from(adminUsers),
  ]);
  return { items, total: Number(cnt.n), page, pageSize };
}

export async function createAdmin(input: { username: string; role: string; password: string }, opts: { operator: string }) {
  const passwordHash = await hashPassword(input.password);
  const [a] = await db.insert(adminUsers).values({ username: input.username, role: input.role, passwordHash, status: "active" }).returning();
  await writeAudit({ operator: opts.operator, action: "admin.manage", target: `admin:${a.id}`, before: null, after: { username: a.username, role: a.role } });
  return { id: a.id, username: a.username, role: a.role, status: a.status };
}

export async function updateAdmin(id: string, patch: { role?: string; status?: string }, opts: { operator: string }) {
  const [before] = await db.select().from(adminUsers).where(eq(adminUsers.id, id));
  if (!before) throw new Error("运营账号不存在");
  const [after] = await db.update(adminUsers).set({ ...patch }).where(eq(adminUsers.id, id)).returning();
  await writeAudit({ operator: opts.operator, action: "admin.manage", target: `admin:${id}`, before: { role: before.role, status: before.status }, after: { role: after.role, status: after.status } });
  return { id: after.id, username: after.username, role: after.role, status: after.status };
}

export async function listAuditLogs(opts: { operator?: string; action?: string; from?: Date; to?: Date; page?: number; pageSize?: number }) {
  const page = opts.page ?? 1, pageSize = opts.pageSize ?? 20;
  const conds: SQL[] = [];
  if (opts.operator) conds.push(eq(adminAuditLogs.operator, opts.operator));
  if (opts.action) conds.push(eq(adminAuditLogs.action, opts.action));
  if (opts.from) conds.push(gte(adminAuditLogs.createdAt, opts.from));
  if (opts.to) conds.push(lte(adminAuditLogs.createdAt, opts.to));
  const where = conds.length ? and(...conds) : undefined;
  const [items, [cnt]] = await Promise.all([
    db.select().from(adminAuditLogs).where(where).limit(pageSize).offset((page - 1) * pageSize).orderBy(sql`${adminAuditLogs.createdAt} desc`),
    db.select({ n: sql<number>`count(*)` }).from(adminAuditLogs).where(where),
  ]);
  return { items, total: Number(cnt.n), page, pageSize };
}
```

- [ ] **Step 3: 写 `routes/admin/system.ts`（账号管理=admin.manage / 审计查询=audit.read）**

```typescript
import { Hono } from "hono";
import { z } from "zod";
import { requirePermission } from "../../middleware/admin-auth"; // spec309
import { listAdmins, createAdmin, updateAdmin, listAuditLogs } from "../../services/admin/admin-accounts";

export const systemRouter = new Hono();

systemRouter.get("/admins", requirePermission("admin.manage"), async (c) => c.json(await listAdmins({ page: Number(c.req.query("page") ?? 1), pageSize: Number(c.req.query("pageSize") ?? 20) })));
const CreateBody = z.object({ username: z.string().min(1), role: z.enum(["superadmin", "ops", "finance", "support"]), password: z.string().min(8) });
systemRouter.post("/admins", requirePermission("admin.manage"), async (c) => {
  const admin = c.get("admin");
  const parsed = CreateBody.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  return c.json(await createAdmin(parsed.data, { operator: admin.username }));
});
const UpdateBody = z.object({ role: z.enum(["superadmin", "ops", "finance", "support"]).optional(), status: z.enum(["active", "disabled"]).optional() });
systemRouter.put("/admins/:id", requirePermission("admin.manage"), async (c) => {
  const admin = c.get("admin");
  const parsed = UpdateBody.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  return c.json(await updateAdmin(c.req.param("id"), parsed.data, { operator: admin.username }));
});

systemRouter.get("/audit-logs", requirePermission("audit.read"), async (c) => {
  const from = c.req.query("from") ? new Date(c.req.query("from")!) : undefined;
  const to = c.req.query("to") ? new Date(c.req.query("to")!) : undefined;
  return c.json(await listAuditLogs({ operator: c.req.query("operator") || undefined, action: c.req.query("action") || undefined, from, to, page: Number(c.req.query("page") ?? 1), pageSize: Number(c.req.query("pageSize") ?? 20) }));
});
```

- [ ] **Step 4: 全量通过 + 合并**

```bash
cd apps/api && bun test
git add apps/api/src/services/admin/admin-accounts.ts apps/api/src/routes/admin/system.ts apps/api/test/admin-system.test.ts
git commit -m "feat(spec310): 系统页(运营账号/角色管理 + 审计日志查询 + admin.manage/audit.read RBAC)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout main && git merge --no-ff phase3/spec310-admin-pages -m "merge spec310: 运营后台功能页(6 页接真实接口 + 配置管理 + 退款审批 + 审计)"
git push origin main
```

---

## 验收清单（spec310）

**地基与 RBAC（贯穿）**
- [ ] admin-api 全挂 `/admin-api` 前缀，与 C 端 `/api` 分离；聚合 `adminApiRouter` 统一套 `requireAdmin`（未登录 401）。
- [ ] 每个**写**端点声明所需 `action` 并经 `requirePermission` 判定；**support 角色对任一写操作（封禁/调积分/退款/改套餐/改配置/管账号）均 403**（测试覆盖）。
- [ ] 所有敏感写操作调 `writeAudit({ operator, action, target, before, after })`，落 `admin_audit_logs`；operator 取 `c.get("admin").username`。

**6 页接口**
- [ ] **概览**：`GET /admin-api/overview` 返回用户数/付费用户/今日收入/积分流水/活跃项目聚合。
- [ ] **用户**：列表/搜索/详情；封禁解封改 `users.status` + 审计前后值；手动调积分调 spec302 `credits.grant`（正负皆可）+ 审计；越权 403。
- [ ] **订单**：列表（状态/类型过滤）/详情（含关联退款）；退款审批调 spec306 `createRefund` + 审计（`refund.write`）；finance 可、support 403。
- [ ] **账本**：按用户查流水（type 过滤 + 分页）；`/ledger/:userId/check` 余额=Σ流水核对（consistent 标记）。
- [ ] **套餐&配置**：plans CRUD（新建/改价 version 自增/上下架）+ 审计；`billing_configs` 读写同一张表，`setConfig` 后 `getConfig` 立即读到新值 + 审计前后值；support 改配置/套餐 403。
- [ ] **系统**：运营账号 CRUD/改角色（仅 superadmin，`admin.manage`）+ 审计；审计日志查询（操作人/动作/时间过滤 + 分页，`audit.read`）。

**通用**
- [ ] 列表统一 `{ items, total, page, pageSize }` 分页 + 过滤；金额 `*_cents`（分）。
- [ ] 消费既有 service（spec302/306/301/304/309），不重复实现；service 与 route 分离、可直调测试；mock provider/会话夹具不依赖外部。
- [ ] `bun test` 全绿；迁移可重复跑；单文件不超 1000 行；视觉以 `docs/admin-front` 原型为准。

---

## 依赖与落地提示

- **spec309 契约（真实导出/路径）**：`requireAdmin(...roles)`/`requirePermission(perm)` from `middleware/admin-auth`；`writeAudit({operator,action,target,before,after})` from `services/audit`；`Permission`/`hasPermission`/`ROLE_PERMISSIONS` from `services/rbac`；`hashPassword` from `services/admin-auth`；表 `adminUsers`/`adminRoles`/`adminAuditLogs`。`requireAdmin` 为**工厂函数**，聚合层用 `requireAdmin()` 带括号。测试夹具 `makeAdminSession(role)` 由 spec309 提供。
- **角色→权限矩阵**由 spec309 RBAC 定义；本 spec 各写接口的 `perm` 一律引用 spec309 `Permission` 枚举：封禁/解封=`user.write`、调积分=`credit.adjust`、退款=`refund.write`、套餐=`plan.write`、配置=`config.write`、账号管理=`admin.manage`、审计查询=`audit.read`；support 在矩阵中无写权限 → 自动 403。
- **配置即生效**依赖 `getConfig` 无缓存直查库（spec301 现状）；若引入缓存层，`setConfig` 须同步失效对应 key。
- **退款唯一入口**：`POST /admin-api/refunds`（spec306 已删自建路由，只留 `createRefund` service）。admin-api 层在 `refundsRouter` 过 `requirePermission("refund.write")` + 用真实 `writeAudit` 补写 `action:"refund.write"`；spec306 service 内若有 `auditLog` 占位（console）不冲突（可保留或移除）。
