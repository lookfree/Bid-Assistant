# spec305 · 会员到期提醒 + 手动续费闭环（架构 §6.2，无自动续费）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 2026-07 决策：不做自动续费/周期代扣（原 spec305-auto-renew 作废）。本 spec 是其替代：**到期提醒 Cron + 用户手动扫码续费 + 订阅状态机**。

**Goal:** 落地架构 §6.2：① **到期提醒 Cron**——扫描 `current_period_end` 临近（T-7/T-3/T-1 档，`billing_configs.renewal_reminder_days` 可配）且 `status=active` 的订阅，推送提醒（渠道可注入；短信模板/站内信就绪前**不注册提醒 Cron**——console 假发送会白耗去重档位），**同一订阅同一周期同一档只提醒一次**（幂等键=订阅+周期末+档，落 renewal_reminders 表）；**每次扫描只发最紧迫一档**（临到期才订阅的用户不被 T-7/T-3/T-1 连环轰炸，被跳过的外档不补发）；② **手动续费**——会员中心「续费」入口 → 建 `payment_orders(type=renewal)`（金额=所选套餐当期价，**服务端从 plans 取价**）→ 复用 spec304 单笔支付链路 → 支付成功回调/轮询 → **续期 `current_period_end` + 发放当期赠送积分(grant)**，续期与发放同事务、幂等键=`renewal:<orderId>`；③ **订阅状态机 Cron**——到期未续费 `active → past_due`（宽限期 `renewal_grace_days` 可配）→ `expired`，权益降级免费版。

**Architecture:** 全部在 App 层（钱只在 App 动）。两个 Cron（提醒/状态推进）经 spec303 `registerCron` 注册、锁内执行、DB 为准扫描、业务幂等键兜底。续费支付完全复用 spec304 的订单服务与路由（`markPaid` 后按订单 type=renewal 分支进续期逻辑）；**续期基准**：未过期续费从 `current_period_end` 顺延一周期（不吞剩余天数），已过期续费从支付时刻起新周期。提醒渠道复用 Phase 0 短信服务 + 站内通知（如无站内信基建则首版仅短信，留接口）。

**Tech Stack:** Hono 4.12、Bun、Drizzle ORM、PostgreSQL、spec303 Cron、spec304 支付、spec302 账本、bun:test。

## Global Constraints

见 `spec300-index.md`。本 spec 关键（钱相关从严）：
- **服务端定价**：续费金额由服务端从 `plans` 当前价取并快照进订单；客户端只传 `planId`。
- **续期与积分发放同事务 + 幂等**：`markPaid(type=renewal)` → 同一事务内续期 subscription、`grant({type:"grant", idempotencyKey: "renewal:"+orderId})`；重复回调不重复续期/发放（幂等键 + 条件 UPDATE）。
- **提醒幂等**：`renewal_reminders` 唯一约束（订阅, 周期末, 档）落库去重（防 Cron 双触发骚扰用户）；每次扫描只发最紧迫一档；notify 失败回滚去重行待下轮重试（单坏号不毒死整轮）。
- **状态机单向**：`active → past_due → expired` 由 Cron 条件 UPDATE 推进；续费成功把 `past_due/expired → active` 并重置周期。
- 天数档/宽限期全部读 `billing_configs`，不写死。
- TDD（`bun test`）；`main` 上先开分支 `phase3/spec305-renewal-reminder`。

---

## File Structure

```
apps/api/src/
├── services/renewal.ts        # 新：到期提醒扫描 + 订阅状态推进 + 续费入账（markPaid renewal 分支调用）
├── routes/membership.ts       # 改/新：POST /api/membership/renew（建 renewal 订单 → 返回 payUrl）
└── crons/renewal.ts           # 新：注册 remind-cron（每日）+ subscription-state-cron（每日）
apps/api/test/
├── renewal-remind.test.ts     # 新：T-7/T-3/T-1 命中/去重/不打扰 past_due
├── renewal-pay.test.ts        # 新：续费下单服务端取价 / 支付成功续期+发积分一次 / 重复回调不重复
└── subscription-state.test.ts # 新：active→past_due→expired 推进 + 续费复活
```

---

## Interfaces

- **Consumes**：spec301 `subscriptions/plans/billing_configs`；spec302 `grant`；spec303 `registerCron`；spec304 `createOrder/markPaid/PaymentProvider`；Phase 0 短信服务。
- **Produces（已按实现+review 定稿）**：
  - `renewOnPaid({orderId, userId, planId, creditsSnapshot, cycleSnapshot}, tx, deps?)`：markPaid(type=renewal) 事务内调用；权益以订单快照为准；订阅行 upsert+FOR UPDATE 串行化（subscriptions 一人一行唯一索引，迁移 0014）。
  - `POST /api/membership/renew {planId}`（spec308 会员中心调）：服务端取价 + 权益快照（amountCents/cycleSnapshot/creditsSnapshot）落单；开放单上限 5（429）。
  - `advanceSubscriptionStates(now)` / `scanRenewalReminders(now, {notify})`（notify 必传）；`renewalCronJobs({notify?})`——subscription-state 始终注册，renewal-remind 仅在提供 notify 渠道时注册。
  - 订单可支付窗 7 天（超期 PAID 拒入账 reason=stale_order，防囤旧价单套利）。

---

## Task 1: 订阅状态机 + 续费入账（renewal.ts）

- [ ] **Step 1: 开分支** `git checkout -b phase3/spec305-renewal-reminder`
- [ ] **Step 2: 失败测试 `subscription-state.test.ts`** —— 到期 active→past_due（宽限内）；宽限尽头→expired；条件 UPDATE 幂等（重复跑不重复推进）。
- [ ] **Step 3: 失败测试 `renewal-pay.test.ts`** —— `renewOnPaid`：未过期从 period_end 顺延一周期、已过期从 now 起；grant 幂等键 `renewal:<orderId>` 重复调用只发一次；past_due/expired 续费后复活为 active。
- [ ] **Step 4: 实现 `services/renewal.ts`** → 全绿。
- [ ] **Step 5: 提交** `feat(spec305): subscription state machine + renewal settlement`

## Task 2: 到期提醒 Cron + 续费路由

- [ ] **Step 1: 失败测试 `renewal-remind.test.ts`** —— 命中 T-7/T-3/T-1 档各提醒一次；同档重复扫描去重；非 active 不提醒；天数档读配置。
- [ ] **Step 2: 实现提醒扫描 + `crons/renewal.ts` 注册两个 Cron（spec303）**。
- [ ] **Step 3: `POST /api/membership/renew {planId}`** —— 服务端取价建 renewal 订单 → 返回 `{orderId, payUrl}`（复用 spec304）；测试：客户端传假金额被忽略。
- [ ] **Step 4: 提交** `feat(spec305): renewal reminder cron + renew route`

## Task 3: 接缝与合并

- [ ] **Step 1: spec304 `markPaid` 接 renewal 分支**（type=renewal → `renewOnPaid`），补跨模块测试：扫码续费全链路（mock 网关）。
- [ ] **Step 2: 全量 `./test-on-mbp.sh` 全绿 → merge `phase3/spec305-renewal-reminder` → push。**

---

## 验收清单（spec305）

- [ ] 到期提醒按档触发（每次扫描只发最紧迫一档，外档不补发）、幂等去重、天数可配；提醒不打扰非 active 订阅；无 notify 渠道不注册提醒 Cron。
- [ ] 手动续费：服务端定价、支付成功续期+发放当期积分**恰好一次**（重复回调/并发安全）；未过期顺延、已过期从 now 起。
- [ ] 订阅状态机 active→past_due→expired 由 Cron 推进，宽限期可配；续费复活。
- [ ] 无任何签约/代扣/自动扣款路径；`bun test` 全绿。
