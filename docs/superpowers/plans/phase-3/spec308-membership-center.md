# spec308 · C 端会员中心接真实数据(渐进式套餐展示)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: 执行本计划前必须先加载并遵循 `superpowers:subagent-driven-development`(子代理驱动开发)。每个 Task 独立用 TDD(先写 `bun:test` 真实测试 → 红 → 实现 → 绿 → 提交)。**不要**编造接口、不要写占位实现(no `TODO`/`stub`/空 `return`),所有代码必须可运行、测试必须真实断言。本 spec 依赖 spec301(账单数据模型)、spec302(积分账本服务)、spec304(支付下单)、spec305(到期提醒+手动续费)已完成;若依赖未就绪,先停下来上报,不要 mock 掉真实服务。

**Goal:** 把 C 端会员中心页(`app/(tool)/membership/page.tsx`)从本地 demo 数据(`lib/plans.ts` 的 `memberTiers` / `DEMO_CREDIT_BALANCE` / 硬编码 `orders`)切换为真实后端数据。后端新增**会员中心聚合接口** `GET /api/membership`(当前订阅 + 积分余额 + 套餐列表 + 渐进式展示:当前档 + 下一档)、**积分流水分页** `GET /api/credits/transactions`、**我的订单** `GET /api/orders`;前端将充值入口接到 spec304 `POST /api/payment/recharge`、开通/续费会员接到 spec305 `POST /api/membership/renew`（扫码单笔，**无自动续费**）、邀请入口接到 spec307 的真实路由 `GET /api/referral/code` + `GET /api/referral/list`(只展示我的邀请码 + 邀请列表,不做绑定写接口;绑定在注册流程 Phase 0 完成,若未就绪则保留入口按钮但走 feature flag)。实现架构文档 §5.3「渐进式套餐展示」。

**Architecture:** App 层 = Hono 4.12 + Bun + Drizzle ORM + PostgreSQL(public schema)+ Zod;前端 = Next.js App Router(`app/(tool)/membership`)+ React client component。后端读 spec301 的表(`plans` / `subscriptions` / `credit_transactions` / `credit_balances` / `payment_orders`),调 spec302 的 `credits` 服务(`getBalance`),不直接重算余额。所有金额以 `*_cents`(分)存储;返回前端时由 App 层转 camelCase(复用 spec207 的 `toCamel`,`apps/api/src/lib/case.ts`)并把分→元。鉴权用 Phase 0 `authMiddleware`,取当前用户。

**Tech Stack:** Hono 4.12 / Bun / Drizzle ORM / PostgreSQL / Zod / `bun:test`;前端 Next.js + React + Tailwind + lucide-react。

---

## Global Constraints

1. **真实 TDD**:每个 Task 先写 `bun:test` 测试,跑 `bun test` 看红,再写实现到绿。测试断言真实数据形状与边界,不写 `expect(true)` 之类空测。
2. **不重算余额**:余额一律走 `credits.getBalance(userId)`(spec302),不在本 spec 里写 `Σ流水` 逻辑。
3. **只读为主**:本 spec 三个接口全部为 `GET`(只读),不写库、不发起支付/扣款。充值/续费/邀请由前端跳转或调用 spec304/305/307 已有的写接口。
4. **鉴权统一**:所有路由挂 `authMiddleware`。取用户 ID 用统一 helper `getUserId(c)`(见 Interfaces),屏蔽 spec 间 `c.get("user")` vs `c.get("userId")` 的不一致(spec004 设 `user` 对象,spec207/304/305 用 `userId`)。**Task 0 必须先落地这个 helper 并测试它兼容两种写法**。
5. **金额/字段转换**:后端 DB 是 snake_case + `*_cents`。出参统一:① 用 `toCamel` 转键;② 金额字段 `*_cents`(分)→对外暴露为元的 `*Yuan`(number,保留两位)同时保留分值 `*Cents`,前端按需取。积分为整数,直接传。
6. **渐进式展示(架构 §5.3)**:`GET /api/membership` 的 `progressive` 字段只返回**当前档 + 下一档**两条;若已是最高档(professional),`next` 为 `null`;未订阅用户当前档视为 `free`,下一档为 `personal`。
7. **分页规范**:`GET /api/credits/transactions` 与 `GET /api/orders` 用 `?page=1&pageSize=20`(Zod 校验,`pageSize` 上限 100,默认 20,`page` 从 1 开始),返回 `{ items, page, pageSize, total, hasMore }`。
8. **幂等/无副作用**:聚合接口若发现 `credit_balances` 缓存缺失,允许 `getBalance` 内部刷新(那是 spec302 的行为),本 spec 不额外写库。
9. **错误处理**:未登录 → 401;参数非法 → 400(Zod);用户存在但无订阅 → 200 返回 free 档结构(不是 404)。
10. **每个 Task 结束 `git commit`**,message 末尾附:
    ```
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    ```
11. **分支**:`phase3/spec308-membership-center`。
12. **行数约束**:单源码文件不超过 1000 行,超出按职责拆分。

---

## File Structure

```
apps/api/src/
  lib/
    auth-user.ts            # Task0 新增:getUserId(c) 统一取用户 ID(兼容 user 对象 / userId)
    money.ts                # Task0 新增:centsToYuan / yuanToCents
    pagination.ts           # Task0 新增:parsePagination(query) -> {page,pageSize,offset}
  services/
    membership.ts           # Task1 新增:getMembershipOverview(userId)
    credits-history.ts      # Task2 新增:listCreditTransactions(userId, {page,pageSize})
    order-history.ts        # Task3 新增:listOrders(userId, {page,pageSize})
  routes/
    membership.ts           # Task1 新增:GET /api/membership
    credits.ts              # Task2 新增:GET /api/credits/transactions (mount /api/credits)
    orders.ts               # Task3 新增:GET /api/orders
  app.ts                    # 各 Task 挂载路由

apps/api/test/
  lib/auth-user.test.ts
  lib/money.test.ts
  lib/pagination.test.ts
  services/membership.test.ts
  services/credits-history.test.ts
  services/order-history.test.ts
  routes/membership.route.test.ts
  routes/credits.route.test.ts
  routes/orders.route.test.ts

# 前端(已存在,改造)
app/(tool)/membership/page.tsx     # Task5 接真实接口
lib/membership-api.ts              # Task4 新增:前端 fetch 封装 + 类型(复用 lib/plans.ts 的 TierId 等)
lib/membership-types.ts            # Task4 新增:后端出参 TS 类型(MembershipOverview 等)
```

---

## Interfaces

### App 层公共 helper(Task0)

```ts
// apps/api/src/lib/auth-user.ts
import type { Context } from "hono"
/** 统一取当前用户 ID:优先 c.get("userId"),否则 c.get("user")?.id;都没有抛 401。 */
export function getUserId(c: Context): string

// apps/api/src/lib/money.ts
export function centsToYuan(cents: number): number   // 分→元,保留两位,number
export function yuanToCents(yuan: number): number     // 元→分,四舍五入到整数分

// apps/api/src/lib/pagination.ts
import { z } from "zod"
export const paginationSchema: z.ZodType<{ page: number; pageSize: number }>
export function parsePagination(query: Record<string, string | undefined>): {
  page: number; pageSize: number; offset: number
}
```

### 后端服务接口

```ts
// apps/api/src/services/membership.ts
export interface PlanView {
  id: string
  name: string
  tierId: "free" | "personal" | "professional"   // 由 plan 元数据/features 映射
  priceMonthCents: number; priceMonthYuan: number
  priceYearCents: number;  priceYearYuan: number
  grantCreditsPerCycle: number
  features: { text: string; included: boolean }[]
  recommended: boolean
}
export interface SubscriptionView {
  status: "active" | "past_due" | "expired" | "none"
  planId: string | null
  tierId: "free" | "personal" | "professional"
  billingCycle: "month" | "quarter" | "year" | null
  autoRenew: boolean
  currentPeriodStart: string | null   // ISO
  currentPeriodEnd: string | null      // ISO,到期时间
}
export interface MembershipOverview {
  subscription: SubscriptionView
  balance: number                       // 积分余额,来自 credits.getBalance
  plans: PlanView[]                      // 全部套餐(供完整对比表)
  progressive: { current: PlanView; next: PlanView | null }  // §5.3 当前档+下一档
}
export function getMembershipOverview(userId: string): Promise<MembershipOverview>

// apps/api/src/services/credits-history.ts
export interface CreditTxView {
  id: string
  type: "grant" | "purchase" | "hold" | "settle" | "release" | "expire" | "referral_reward"
  amount: number          // 带符号 ±
  ref: string | null
  expireAt: string | null // ISO
  createdAt: string       // ISO
}
export function listCreditTransactions(
  userId: string, opts: { page: number; pageSize: number; offset: number }
): Promise<{ items: CreditTxView[]; total: number }>

// apps/api/src/services/order-history.ts
export interface OrderView {
  id: string
  type: "recharge" | "purchase" | "renewal"
  amountCents: number; amountYuan: number
  status: "created" | "paid" | "failed" | "refunded"
  provider: string
  createdAt: string       // ISO
}
export function listOrders(
  userId: string, opts: { page: number; pageSize: number; offset: number }
): Promise<{ items: OrderView[]; total: number }>
```

### HTTP 接口

```
GET /api/membership
  auth: required
  200: MembershipOverview(已 toCamel + 金额含 *Cents/*Yuan)
  401: { error: "unauthorized" }

GET /api/credits/transactions?page=1&pageSize=20
  auth: required
  200: { items: CreditTxView[], page, pageSize, total, hasMore }
  400: zod error  401: unauthorized

GET /api/orders?page=1&pageSize=20
  auth: required
  200: { items: OrderView[], page, pageSize, total, hasMore }
  400 / 401 同上
```

### 前端封装(Task4)

```ts
// lib/membership-types.ts  —— 与后端出参一一对应(camelCase)
export interface SubscriptionView { /* 同上,字段 camelCase */ }
export interface PlanView { /* 同上 */ }
export interface MembershipOverview { /* 同上 */ }
export interface CreditTxView { /* 同上 */ }
export interface OrderView { /* 同上 */ }
export interface Paged<T> { items: T[]; page: number; pageSize: number; total: number; hasMore: boolean }

// lib/membership-api.ts
export function fetchMembership(): Promise<MembershipOverview>
export function fetchCreditTransactions(page?: number, pageSize?: number): Promise<Paged<CreditTxView>>
export function fetchOrders(page?: number, pageSize?: number): Promise<Paged<OrderView>>
export function startRecharge(packCredits: number, amountCents: number): Promise<{ qrCode?: string; payUrl?: string; orderId: string }>  // → POST /api/payment/recharge (spec304)
export function renewMembership(planId: string): Promise<{ orderId: string; payUrl: string }>  // → POST /api/membership/renew (spec305，扫码单笔)
```

---

## Task 0 — App 层公共 helper(getUserId / money / pagination)

**目标**:先把三个被后续 Task 复用的纯工具落地,消除 `c.get("user")` vs `c.get("userId")` 的歧义。

**TDD 步骤**:
1. 写 `test/lib/auth-user.test.ts`:
   - 构造一个最小 Hono `Context`(或用 `app.request` + 中间件注入)分别 set `userId` 字符串、set `user` 对象(`{ id }`)、两者都没有。
   - 断言:有 `userId` → 返回该字符串;只有 `user.id` → 返回 `user.id`;都没有 → 抛错(可被路由层转 401)。
2. 写 `test/lib/money.test.ts`:`centsToYuan(3900)===39`、`centsToYuan(159900)===1599`、`centsToYuan(1)===0.01`;`yuanToCents(39)===3900`、`yuanToCents(0.1)===10`;边界 `0`。
3. 写 `test/lib/pagination.test.ts`:默认 `{page:1,pageSize:20,offset:0}`;`page=3,pageSize=10 → offset 20`;`pageSize=1000` 被截到 100;`page=0` / 负数 / 非数字 → 报错或归 1(选定一种语义并测试);`offset=(page-1)*pageSize`。
4. `bun test`(红)→ 实现 `auth-user.ts` / `money.ts` / `pagination.ts` → 绿。
5. `git commit -m "spec308 task0: app 层 getUserId/money/pagination 公共 helper"`(附 Co-Authored-By)。

**验收**:三个 helper 测试全绿;`getUserId` 兼容两种鉴权写法。

---

## Task 1 — 会员中心聚合接口 GET /api/membership(含渐进式展示)

**依赖**:Task0;spec301 表;spec302 `credits.getBalance`。

**TDD 步骤**:
1. 写 `test/services/membership.test.ts`(用真实测试库/事务回滚 fixture,种入 `plans`(free/personal/professional 三档)、可选 `subscriptions`、`credit_balances`/流水):
   - **未订阅用户**:`getMembershipOverview` 返回 `subscription.status==="none"`、`tierId==="free"`、`autoRenew===false`、`currentPeriodEnd===null`;`balance` 来自 `getBalance`;`plans.length===3`;`progressive.current.tierId==="free"`、`progressive.next.tierId==="personal"`。
   - **personal 订阅 active**:`subscription.tierId==="personal"`、`status==="active"`、`currentPeriodEnd` 为 ISO 串、`autoRenew` 透传;`progressive.current.tierId==="personal"`、`progressive.next.tierId==="professional"`。
   - **professional 订阅**:`progressive.next===null`(已最高档)。
   - **过期订阅**(`status==="expired"` 或 `currentPeriodEnd < now`):降级展示,`tierId` 仍读 plan 但 `status` 为 `expired`;`progressive.current` 取该档。
   - 金额字段:`priceMonthYuan` 与 `priceMonthCents` 一致换算(用 Task0 `centsToYuan`)。
2. 写 `test/routes/membership.route.test.ts`(`app.request("/api/membership", {headers:{Authorization}})`):
   - 带合法 token → 200,body 已 camelCase,含 `subscription/balance/plans/progressive`。
   - 无 token → 401。
   - 验证 `progressive` 只含 `current` + `next` 两键。
3. `bun test`(红)→ 实现:
   - `services/membership.ts`:`getMembershipOverview(userId)`:
     - `db.select` 全部 `plans`(`status="active"`),映射成 `PlanView`(`tierId` 由 plan `features`/`name` 或一张固定映射推导:price=0→free、personal 价位→personal、professional→professional;具体推导规则在实现里以 plan 上的稳定标识为准,**不要**用中文名脆弱匹配——若 spec301 plan 表无 tier 字段,实现时新增按 `grantCreditsPerCycle`/价格档位的确定性映射并在测试里钉死)。
     - 查该 `userId` 的 `subscriptions`(取最新一条 active/past_due,否则 expired,否则 none)。
     - `balance = await credits.getBalance(userId)`。
     - 计算 `progressive`:按 free<personal<professional 顺序定位 `current` 索引,`next = order[i+1] ?? null`。
   - `routes/membership.ts`:`new Hono()`,`authMiddleware`,`getUserId(c)`,调服务,出参 `toCamel` + 金额加 `*Yuan`,`c.json(...)`。
   - `app.ts`:`app.route("/api/membership", membershipRoutes)`。
4. 绿后 `git commit -m "spec308 task1: GET /api/membership 聚合接口(渐进式当前档+下一档)"`(附 Co-Authored-By)。

**验收**:四类用户(未订阅/personal/professional/过期)用例全绿;`progressive` 行为符合架构 §5.3;余额走 `getBalance` 非自算。

---

## Task 2 — 积分流水分页 GET /api/credits/transactions

**依赖**:Task0;spec301 `credit_transactions` 表。

**TDD 步骤**:
1. 写 `test/services/credits-history.test.ts`:种入某 user 25 条 `credit_transactions`(不同 `type`、带符号 `amount`、部分有 `expireAt`)。
   - `listCreditTransactions(userId,{page:1,pageSize:20,offset:0})` → `items.length===20`、`total===25`,按 `createdAt desc` 排序。
   - 第二页 `offset:20` → `items.length===5`。
   - 只返回该 user 的流水(种入另一 user 的数据验证隔离)。
   - 字段映射:`type/amount/ref/expireAt/createdAt`,ISO 字符串。
2. 写 `test/routes/credits.route.test.ts`:
   - `GET /api/credits/transactions?page=1&pageSize=20` → 200,`{items,page,pageSize,total,hasMore:true}`;第二页 `hasMore:false`。
   - `pageSize=999` 被截到 100(透传 Task0 pagination)。
   - `page=abc` → 400。无 token → 401。
3. `bun test`(红)→ 实现 `services/credits-history.ts` + `routes/credits.ts`(`app.route("/api/credits", creditsRoutes)`,内部 `GET /transactions`),用 `parsePagination`、`getUserId`、`toCamel`、`hasMore = offset+items.length < total`。
4. `git commit -m "spec308 task2: GET /api/credits/transactions 积分流水分页"`(附 Co-Authored-By)。

**验收**:分页/排序/用户隔离/参数校验用例全绿。

---

## Task 3 — 我的订单 GET /api/orders

**依赖**:Task0;spec301 `payment_orders` 表。

**TDD 步骤**:
1. 写 `test/services/order-history.test.ts`:种入某 user 多条 `payment_orders`(不同 `type`/`status`/`amountCents`)。
   - 分页同 Task2 规则;`createdAt desc`;用户隔离。
   - `amountCents`→`amountYuan` 用 `centsToYuan` 一致;`status`/`provider`/`type` 透传。
2. 写 `test/routes/orders.route.test.ts`:`GET /api/orders?page=1&pageSize=20` → 200 `{items,page,pageSize,total,hasMore}`;无 token → 401;非法 page → 400。
3. `bun test`(红)→ 实现 `services/order-history.ts` + `routes/orders.ts`(`app.route("/api/orders", ordersRoutes)`)。
4. `git commit -m "spec308 task3: GET /api/orders 我的订单分页"`(附 Co-Authored-By)。

**验收**:订单分页/金额换算/隔离/校验用例全绿。

---

## Task 4 — 前端 API 封装与类型(lib/membership-api.ts / lib/membership-types.ts)

**依赖**:Task1–3 的接口契约。

**TDD 步骤**(前端纯函数/封装用 `bun:test` 测,fetch 用注入或 mock global fetch):
1. 写 `lib/__tests__/membership-api.test.ts`:
   - `fetchMembership` 命中 `GET /api/membership`,带 `Authorization`(从既有 auth helper 取 token,沿用项目现有方式),返回体按 `MembershipOverview` 解析。
   - `fetchCreditTransactions(2, 20)` 拼出 `?page=2&pageSize=20`。
   - `fetchOrders` 同理。
   - `startRecharge` → `POST /api/payment/recharge`,body `{ amountCents, credits }`(对齐 spec304 入参);返回 `{qrCode?,payUrl?,orderId}`。
   - `renewMembership(planId)` → `POST /api/membership/renew`,body `{planId}`(对齐 spec305,金额服务端定价);返回 `{orderId, payUrl}`,前端把 payUrl 转二维码弹层供扫码。
   - 非 2xx → 抛错(含状态码),401 → 触发既有未登录处理(沿用项目约定)。
2. `lib/membership-types.ts`:声明上文五个 camelCase 类型 + `Paged<T>`;**复用** `lib/plans.ts` 的 `type TierId`(`import type { TierId } from "@/lib/plans"`),避免重复定义档位枚举;`Feature` 复用 `lib/plans.ts` 的 `Feature`。
3. `bun test`(红)→ 实现 → 绿。
4. `git commit -m "spec308 task4: 前端 membership API 封装与类型(复用 plans.ts TierId)"`(附 Co-Authored-By)。

**验收**:封装函数 URL/method/body 正确;类型复用 `lib/plans.ts`;错误处理覆盖 401/非 2xx。

---

## Task 5 — 改造会员中心页接真实数据(app/(tool)/membership/page.tsx)

**依赖**:Task4。

**步骤**(此页为 client component,以可观测行为驱动:抽出可测的纯展示/映射逻辑用 `bun:test` 覆盖,UI 渲染部分人工 + 类型保证):
1. 把页面顶部的 demo 来源替换:
   - 删除对 `DEMO_CREDIT_BALANCE` 的依赖与硬编码 `orders` 数组;
   - 用 `useEffect` + `fetchMembership()` 加载 `MembershipOverview`,`fetchOrders()` 加载订单,`fetchCreditTransactions()` 加载流水(各带 loading/error/空态)。
2. **真实渲染**:
   - 余额:`overview.balance`(替换 `credits` 初值)。
   - 订阅状态:`overview.subscription`(档位 `tierId`/`status`/`currentPeriodEnd` 到期日/`autoRenew` 开关态/`billingCycle`)。
   - 套餐:用 `overview.plans` 渲染完整对比;**渐进式区块**用 `overview.progressive.current` + `overview.progressive.next` 渲染「当前档 / 推荐升级到下一档」;`next===null` 时显示「已是最高档」。
   - 仍可复用 `lib/plans.ts` 的 `creditCosts`/`creditPacks`(消耗说明、充值包目录是产品静态文案,保留;但充值价格以接口/配置为准时优先接口)。
3. **入口接线**:
   - 升级/开通/续费按钮 → `renewMembership(plan.id)` → 拿 `payUrl` 展示扫码二维码弹层(spec305);支付结果轮询我方订单接口。
   - 充值包 `buyPack` → `startRecharge(pack.credits, yuanToCents(pack.price))` → 用返回的 `qrCode`/`payUrl` 展示/跳转(spec304)。
   - 邀请入口 → 接 spec307 的**真实路由**:`GET /api/referral/code`(单数,取「我的邀请码」)+ `GET /api/referral/list`(邀请列表);并用环境开关 `NEXT_PUBLIC_REFERRAL_ENABLED` 守卫;开关关闭时按钮置灰/隐藏,**不**留死链。会员中心只**展示**「我的邀请码 + 邀请列表」,**不**做「输入邀请码绑定」——绑定在注册流程(Phase 0)完成,spec307 不产出任何 `/bind` 写接口,故此处**禁止**假设 `POST /api/referrals/bind` 之类路由。实现时若 spec307 已就绪则直接对接上述两个真实接口,否则保留入口 + flag 并在 PR 描述里标注「待 spec307」。
4. 抽出纯逻辑(如 `pickProgressive`、`formatPeriodEnd`、`tierLabel`)到可测模块并写 `bun:test`。
5. `bun test` 全绿 + 前端类型检查通过(`tsc --noEmit` 或项目既有 lint)。
6. `git commit -m "spec308 task5: 会员中心页接真实接口(余额/订阅/渐进式套餐/充值/续费/邀请入口)"`(附 Co-Authored-By)。

**验收**:页面不再引用 `DEMO_CREDIT_BALANCE` 与硬编码 orders;余额/订阅/套餐/流水/订单全部真实渲染;渐进式区块正确显示当前档+下一档;充值/续费按钮调通 spec304/305;邀请入口接 spec307 或 flag 守卫。

---

## Task 6 — 集成串联与回归

**步骤**:
1. 在 `apps/api/src/app.ts` 确认三条路由均已挂载(`/api/membership`、`/api/credits`、`/api/orders`),且都在 `authMiddleware` 之后。
2. 写一条端到端集成测试 `test/integration/membership-e2e.test.ts`:
   - 种一个 user + personal active 订阅 + 若干流水 + 若干订单;
   - 依次请求三个接口,断言:聚合返回订阅+余额+套餐(含 `progressive.next` 为 professional)、流水分页 `hasMore` 正确、订单分页正确;
   - 未登录请求三接口全部 401。
3. 全量 `bun test` 绿;前端 `tsc`/lint 绿。
4. `git commit -m "spec308 task6: 会员中心端到端集成测试与路由挂载回归"`(附 Co-Authored-By)。

**验收**:全量测试绿;三接口在 `app.ts` 正确挂载且受鉴权保护。

---

## 验收清单(整体)

- [ ] 分支 `phase3/spec308-membership-center`,每个 Task 一次提交,均附 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- [ ] Task0 `getUserId` 兼容 `c.get("user")` 与 `c.get("userId")` 两种写法并有测试。
- [ ] `GET /api/membership` 返回 `subscription` + `balance` + `plans` + `progressive{current,next}`;余额来自 `credits.getBalance`(spec302),非本 spec 自算。
- [ ] 渐进式展示(架构 §5.3):仅返回当前档 + 下一档;professional 时 `next===null`;**未订阅用户返回 free 档 + 下一档 personal(升级入口),不返回 404**。
- [ ] `GET /api/credits/transactions` 分页(`page/pageSize`,上限 100),按 `createdAt desc`,用户隔离,带符号 `amount`,`hasMore` 正确。
- [ ] `GET /api/orders` 分页,`amountCents`/`amountYuan` 一致换算,用户隔离。
- [ ] 出参经 `toCamel`(复用 spec207 `apps/api/src/lib/case.ts`);金额同时含 `*Cents` 与 `*Yuan`。
- [ ] 三接口均挂 `authMiddleware`,未登录 → 401;参数非法 → 400。
- [ ] 前端 `app/(tool)/membership/page.tsx` 移除 `DEMO_CREDIT_BALANCE` 与硬编码 `orders`;余额/订阅状态/到期/套餐/流水/订单真实渲染(无自动续费开关)。
- [ ] 前端类型复用 `lib/plans.ts` 的 `TierId`/`Feature`,新增 `lib/membership-types.ts` 与 `lib/membership-api.ts`。
- [ ] 充值入口 → spec304 `POST /api/payment/recharge`;开通/续费 → spec305 `POST /api/membership/renew`(扫码单笔,无自动续费开关);邀请入口 → spec307 的 `GET /api/referral/code` + `GET /api/referral/list`(只展示我的码+列表,不做 `/bind` 绑定;绑定在注册流程 Phase 0 完成)(或 `NEXT_PUBLIC_REFERRAL_ENABLED` flag 守卫,标注待 spec307)。
- [ ] 端到端集成测试覆盖三接口 + 401;全量 `bun test` 与前端类型检查全绿。

---

## 实施备注(给执行者)

1. **依赖前置**:spec306/spec307(邀请)在编写本计划时**尚不存在**(phase-3 目录最高到 spec305)。Task5 的邀请入口务必用 feature flag 守卫,不要因 spec307 缺失而阻塞本 spec 主体(会员中心 + 充值 + 续费)。
2. **plan→tierId 映射**:spec301 的 `plans` 表无显式 `tier` 列。实现 `membership.ts` 时请用**确定性规则**(如按 `priceCents`/`grantCreditsPerCycle` 档位或在 billing-seed 给 plan 加稳定 `code`),并在测试里钉死映射,**禁止**用中文 `name` 模糊匹配。若需要给 `plans` 加 `code`/`tier` 列,作为本 spec 的小幅 schema 增量在 Task1 内完成并迁移。
3. **鉴权字段不一致**:已知 spec004 设 `c.set("user", user)`、spec207/304/305 用 `c.get("userId")`;本 spec 用 Task0 的 `getUserId(c)` 兼容,避免被这个历史不一致绊住。
4. **被邀请人首次付费延迟解锁(`onInviteeFirstPaid`)**:本 spec 的会员中心是**只读 + 跳转**(见 Global Constraint #3),**不包含**任何「购买/激活会员成功」的服务端处理——会员激活与首次付费判定全部发生在 spec304 `markPaid` 里。因此延迟解锁触发点 `await onInviteeFirstPaid(userId).catch(()=>{})`(`import { onInviteeFirstPaid } from "../services/referral"`,spec307 导出且**幂等**)由 **spec304 `markPaid` 在会员激活成功处接线**,本 spec **不重复**调用,也**不**在会员中心新增激活逻辑。若后续本 spec 真的引入了服务端会员激活路径,则需在该激活成功处补一行 `await onInviteeFirstPaid(userId).catch(()=>{})`。
