# Phase 3 · 商业化与运营 —— 实现计划索引（spec300）

> 把架构 §8 的 **Phase 3（商业化）** 细化为 spec301–spec310，每个可独立执行、独立测试。
> 上游基线：架构 §5（计费与数据模型）、§6（会员订阅与支付/到期续费/对账/Cron/邀请/配置，**2026-07 修订：收钱吧扫码单笔，无自动续费**）、§3.2 边界铁律、§3.3 双子域分离；**字段权威**＝《支付与计费系统 · 开发需求规格》第四节（9 张表 + `billing_configs`）。
> **Phase 3 产出目标**：**能付费、能续费（到期提醒+手动扫码）、能邀请，积分能真扣，后台能配置/对账/退款**——把 Phase 1-2 的计费 **stub 换成真账本**，接收钱吧扫码单笔支付，建运营后台（基于 `docs/admin-front` 原型）。

## 核心定位：把 stub 换成真账本，不返工编排

Phase 1-2 已把"计费钩子"留成 stub（`preDeduct/settle/STEP_COST`，spec108/spec207），编排代码不碰钱。Phase 3 **只替换 stub 的实现**，编排（agent_runs/project_steps/按步 run）保持不变：

```
Phase 1-2 stub                          Phase 3 真账本（本阶段）
preDeduct(step) → {ok, hold}     ──▶    校验余额 → 写 hold(-N) 预扣（N 取自 billing_configs 积分口径）
settle(runId, hold) → number     ──▶    按 agent_token_usage 实际用量 → 写 settle，多退少补；失败写 release(+N)
STEP_COST 常量                    ──▶    billing_configs 的「操作→积分」口径（运营可配）
（无）                            ──▶    余额=Σ流水、FIFO 过期、幂等键、余额缓存对账
```

> **边界铁律不变**（§3.2/§5.1）：钱只在 App API 动；智能体服务只上报 usage；所有扣减/回调带 **幂等键**；多来源积分 **FIFO by expire_at**（先过期先扣）。

## 数据模型（9 表 + 配置，字段以规格文档为准；spec301 建表）

| 表 | 关键字段 | 归属 spec |
|---|---|---|
| `plans` | id/name/price/currency/billing_cycle/grant_credits_per_cycle/features(JSON)/limits(JSON)/status/version（**数值由配置注入**） | spec301 |
| `subscriptions` | user_id/plan_id/status(active/past_due/expired)/current_period_start/end（**无 auto_renew/agreement_no**） | spec301 |
| `credit_transactions`（只追加） | id/user_id/type(grant/purchase/hold/settle/release/expire/referral_reward)/amount(±)/source_batch/expire_at/ref/idempotency_key/created_at | spec301 |
| `credit_balances` | user_id/balance（余额缓存，权威仍是 Σ流水） | spec301 |
| `payment_orders` | id/user_id/type(recharge/purchase/renewal)/amount/status(created/paid/failed/unknown/refunded)/provider(shouqianba)/client_sn/provider_trade_no(收钱吧 sn)/channel_trade_no(渠道 trade_no)/payway/idempotency_key | spec301 |
| `payment_terminals` | id/terminal_sn/terminal_key(加密)/device_id/activated_at/last_checkin_at（收钱吧终端凭证，激活/每日签到维护，集群共享） | spec301 |
| `refunds` | id/order_id/amount/reason/status/operator/created_at | spec301 |
| `referrals` | inviter_id/invitee_id/code/status/reward_state(pending/unlocked/capped)/created_at | spec301 |
| `billing_configs` | key/value（积分口径/充值包/汇率/有效期/推荐规则/到期提醒天数/轮询窗口，§6.6） | spec301 |
| `admin_users`/`admin_roles`/`admin_audit_logs` | 运营身份/RBAC/审计（**与 C 端 users 完全分离**，§3.3） | spec309 |

> `plans`/积分口径/模型路由从一开始就**配置化存库**，运营后台只是它们的可视化管理面（§6.6）。所有数值由 `billing_configs` + 种子配置注入，开发只读不写死。

## spec 清单与依赖顺序

| spec | 主题 | 交付物（可测） | 依赖 |
|---|---|---|---|
| **spec301** | 计费数据模型 + 配置化 | 9 表 Drizzle schema（public）+ `billing_configs` + **种子配置加载器**（占位定价：测试版 1 元/周期、赠送 100、操作积分统一 10） | Phase 0 App API |
| **spec302** | 积分账本引擎（★替换 stub） | `credits` 服务：grant/hold/settle/release/expire + 余额=Σ流水 + FIFO 过期 + 幂等键 + 余额缓存；**替换 spec108/207 的 billing-stub**，接 `agent_runs`/`project_steps` | spec301 |
| **spec303** | 定时任务调度（Redis 单例 Cron） | 分布式锁 Cron（`SET NX EX` + Lua CAS 释放 + watchdog 续租）；`withCronLock`/`registerCron`（分钟级 tick）/`startCronRunner`（批量注册 `CronJob`）；供对账/过期/到期提醒复用（§6.4） | Phase 0 Redis |
| **spec304** | 支付抽象 + 收钱吧单笔 | `PaymentProvider` 接口 + `ShouqianbaProvider`（终端激活/每日签到 + WAP2 跳转支付 URL + 查询轮询 + 回调 RSA 验签 + 退款）+ 订单服务（`createOrder`/`markPaid` 幂等状态机，含 unknown 态）；充值下单→回调/轮询→`grant({type:"purchase"})` 入账（会员激活分支留 TODO，spec308 接会员中心补全） | spec301、302 |
| **spec305** | 到期提醒 + 手动续费闭环 | 到期提醒 Cron（`startCronRunner` 注册、扫 current_period_end 临近 T-7/T-3/T-1 档，幂等键=订阅+档，短信/站内推送）+ 续费下单（type=renewal，复用 spec304 单笔链路）→ 支付成功续期 + 发当期赠送积分 + past_due/expired 状态机（宽限期可配） | spec303、304 |
| **spec306** | 对账 + 退款 + 积分过期 | 每日对账 Cron（逐笔调收钱吧查询接口核对终态、清算 unknown 态 vs orders+ledger，差异告警）+ `refunds` 流程（收钱吧退款接口/扣积分）+ 积分过期 Cron（扫 expire_at 写 expire） | spec303、304、302 |
| **spec307** | 推荐奖励引擎（规则全配置化） | `referrals` + 邀请码 + 两段发放（立即/延迟解锁）+ 双方额度 + 封顶(capped) + 防刷风控；奖励落 `referral_reward` 流水 | spec302、301 |
| **spec308** | 会员中心接真实数据（C 端） | C 端 `/membership` 会员中心接真实 subscription/credits/订单/邀请；渐进式套餐展示；充值/开通/续费入口接 spec304/305（**无自动续费开关**，续费=扫码单笔） | spec302、304、305 |
| **spec309** | 运营后台地基（admin 身份 + RBAC + 审计） | `admin_users`/`admin_roles`/`admin_audit_logs` + admin 子域独立登录/会话（§3.3）+ RBAC 中间件（superadmin/ops/finance/support）+ 审计装置 + admin-front 接入骨架 | spec301、Phase 0 |
| **spec310** | 运营后台功能页（基于 admin-front 原型） | 6 页接真实接口：概览/用户(users)/订单(orders)/账本(ledger)/套餐&配置(plans)/系统(system)；含 `billing_configs` 可视化管理 + 退款审批 + 手动调积分/发奖励（均走审计） | spec302–307、spec309 |

> 关键路径：**spec301 数据模型** → **spec302 账本引擎(替 stub)** → (spec303 Cron) → **spec304 收钱吧单笔支付** → **spec305 到期提醒+手动续费** → (spec306 对账/退款/过期 ‖ spec307 邀请) → **spec308 会员中心** → **spec309/310 运营后台**。
> 钱相关三件套（302 账本 / 304 支付 / 305 续费闭环）是 Phase 3 主轴；admin（309/310）消费全部、最后建。

---

## Global Constraints（全局约束 · 每个 spec 隐含包含）

**承接 Phase 0-2（不重述，见各 index）**
- App 层 **Hono 4.12 + Bun + Drizzle ORM + PostgreSQL(public schema) + Zod**；测试 `bun test`。
- bidsaas 库：计费/账本/订阅全部落 **public schema**（drizzle）；Redis（库 3、前缀 `bid:`）做 Cron 锁与缓存。
- 频繁提交（提交信息遵循仓库 CLAUDE.md 规范：英文 Conventional Commits、账号 `lookfree`、不加 `Co-Authored-By`）；`main` 上先开分支。

**钱相关铁律（§3.2 / §5.1，贯穿全程）**
- **钱只在 App API 动**；智能体服务只上报 usage（Phase 1/2 已就位的 `agent_token_usage`）。
- **余额 = Σ流水**（`credit_transactions` append-only），`credit_balances` 仅作缓存与对账，不作权威。
- **所有扣减/支付回调带 `idempotency_key`**；异步通知按 `trade_no` + 订单状态机保证只入账一次。
- 多来源积分 **FIFO by `expire_at`**（先过期先扣）；过期由定时任务写 `expire` 流水。
- **预扣→结算两段式**：hold(-N) → 成功 settle(多退少补) / 失败 release(+N)；N 取自 `billing_configs` 操作口径。

**支付与定时（§6，2026-07 修订）**
- 支付走 **`PaymentProvider` 抽象**：现行 `ShouqianbaProvider`（C 扫 B 跳转支付单笔；聚合微信/支付宝扫码）；**不做自动续费/周期代扣**。
- 无 SDK 依赖（HTTPS+JSON 直连网关）；回调**必须用收钱吧公钥 SHA256WithRSA 验签**；结果获取回调+轮询双通道（4 分钟有效期，超时置 unknown 待对账）；上线前用**测试激活码端到端冒烟**（对应测试商户号，交易真实、付后退款）。
- 终端凭证（terminal_sn/terminal_key）落 `payment_terminals` 集群共享，每日签到轮换；vendor_key/公钥只存 env，不入库不进 git。
- 周期任务（对账/过期/到期提醒）统一走 **Redis 分布式单例 Cron**（§6.4），不引入独立调度器；业务幂等键兜底，双触发不重复处理。

**配置化（§6.6）**
- 所有可调数值集中 **`billing_configs`**；开发期用**种子配置文件**占位（非真实定价），后台 UI（spec310）接管同一批配置，不返工。
- **工作流模板配置不做后台 UI**（预制工作流以代码定义，§10）。

**运营后台（§3.3）**
- admin **与 C 端 `users` 完全分离**：独立身份(`admin_users`)、独立会话、独立子域(`admin.`)；RBAC 角色 superadmin/ops/finance/support。
- 敏感操作（改套餐/调积分/退款/封禁/手动发奖励）**一律留审计**（`admin_audit_logs`：操作人/时间/前后值）。

---

## 实现契约核对（spec 草图 vs 代码库实际约定）

- 各 spec 代码草图里的 `import { db } from "../db"` 在本代码库对应 **`getDb()`（`src/db/client`）惰性单例**；表对象统一从 `src/db/schema`（index barrel）导入。照草图直抄 import 会编译失败。
- spec301 落地时已加固（草图为准之外的从严项）：幂等键 **NOT NULL**、金额/枚举 **CHECK 约束**、`credit_tx_user_expire_idx` FIFO 复合索引——后续 spec 按实际 schema 为准。

## 与前序 Phase 的接缝（替换点，落地时核对）

- **spec108/spec207 的 `billing-stub.ts`**：`preDeduct/settle` 改为调 spec302 的真账本 `credits` 服务；`STEP_COST` 常量删除，改读 `billing_configs` 操作口径。**编排（routes/read.ts、routes/projects.ts）签名不变**，只换实现。
- **`agent_runs`/`project_steps`**：每步 run 的 `cost_points` 从 stub 数改为真实 settle 后的积分；`credit_transactions.ref` 关联 `agent_run`/`project_step`。
- **`users`/`user_identities`/`sessions`**（Phase 0）：C 端账号体系复用；admin 身份**另起**（spec309），不混用。
- **C 端 `/membership`**（原型占位）：spec308 接真实订阅/积分/订单。

---

## spec311：智能体模型运营后台可配（2026-07-05 追加）

**目标**：agent 用哪个大模型（provider/model/fallbacks）由运营后台可视化配、即时生效，取代 env 写死。
**依赖**：spec301 配置机制（`billing_configs`/`getConfig`/`setConfig`）、spec310 admin 通用配置端点（`PUT /plans/configs/:key`）、Phase 1-2 agent 模型网关。
**要点**：App API 权威；`billing_configs` 键 `agent_model`；建 run 随请求体下发 `model` → agent `settings.model_copy` 覆盖 env 默认；API Key 仍留 env；缺省回退 env（向后兼容）。计划：`spec311-agent-model-config.md`。

## 执行方式

每个 spec 用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实现。spec 内步骤用 `- [ ]` 复选框跟踪。
先 spec301 建表 + 种子配置 → spec302 把账本跑通并替换 stub（核心价值：积分能真扣）→ 再收钱吧支付/到期续费/邀请 → 最后运营后台接真实数据。
