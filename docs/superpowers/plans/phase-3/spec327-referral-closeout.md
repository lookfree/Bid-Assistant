# spec327 · 邀请奖励引擎收口（运营后台配置区 + 风控补全 + spec307 勾账） 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 spec307 通用邀请奖励引擎**完整收口到可运营状态**：① 运营后台「套餐与积分口径配置」页（价格菜单）新增**邀请奖励专属配置区**——奖励数值/解锁条件/封顶/有效期/风控阈值全部可视化编辑（当前只有裸键值 PUT 接口，运营无法安全改嵌套 JSON）；② 服务端对这两个配置键加**形状校验**（防运营写坏 JSON 让发奖引擎在发钱路径抛错）；③ 补齐风控缺口「**注册即弃**」判定（配置开关）；④ **盘点勾账 spec307**——实现已大部分落地但 35 项任务 0 勾选，先跑测试核实再如实勾选，文档与代码对齐。

## 实现校正（现状盘点 · 2026-07-22 核对代码）

spec307 的引擎主体**已实现并接线**（勾选状态失真，见 Task 0）：

| 能力 | 状态 | 证据 |
|---|---|---|
| `referrals` 关系 + 邀请码 + `invitee_id` 唯一 | ✅ | `db/schema`（spec301 建）；`services/referral.ts` |
| 注册带码建关系（phone/deviceHash/ip 全采集） | ✅ | `services/auth.ts:109-111` → `bindByCode`；`routes/auth.ts:18`；C 端 login `?ref=` |
| 两段发放 + 双方额度 + 封顶 capped + 幂等键 | ✅ | `services/referral.ts:109-114`（`grantReward` 走 `credits.grant`，幂等键 `referral:<id>:<role>`） |
| 首付解锁钩子（充值 + 续费两分支都覆盖） | ✅ | `services/payment-orders.ts:145`（`markPaid` 公共路径事务外 best-effort，幂等） |
| 风控：设备查重 / 手机查重 / 同 IP 集中(1h 阈值) → 冻结 + 审计 | ✅ | `services/referral-risk.ts`（`assessRisk`/`freezeAndAudit`，阈值读配置 `riskMaxPerIpPerHour`） |
| C 端路由 `GET /api/referral/code` `/list` + 会员中心邀请卡 | ✅ | `routes/referral.ts`；`web/app/(tool)/membership/page.tsx:472+` |
| 配置种子 `referral_rules` + `reward_expire_days`（代码不写死数值） | ✅ | `config/billing-seed.ts:19-27`；`services/referral.ts:28`（缺配置 fail-loud） |
| 后台通用配置端点（GET/PUT + `config.write` 权限 + 审计） | ✅ | `routes/admin/plans.ts:14-24` |
| 测试 5 件（code/reward/risk/routes/wiring） | ✅ 存在 | `test/referral-*.test.ts`（是否全绿见 Task 0） |

**真实缺口（本 spec 的活）：**

1. **后台价格菜单无邀请奖励专属编辑区**——`admin/components/admin/plans/plans-client.tsx` 只有套餐档位 + `credit_cost.*` 积分口径；`referral_rules` 是五键嵌套 JSON，运营只能盲写裸 JSON（PUT 无形状校验，写坏键名/负数会让发奖路径抛错或静默错发）。
2. **`PUT /plans/configs/:key` 对钱相关键零校验**——`ConfigBody = { value: z.unknown() }` 直存。
3. **「注册即弃」风控判定未实现**（设备/IP/手机已有）；**实名唯一**系统无实名体系，只能预留。
4. **spec307 文档 35 项任务 0 勾选**，与实现严重脱节。

## Global Constraints

见 `spec300-index.md`。本 spec 关键：

- **规则全配置化**（沿 spec307 铁律）：新增配置项一律进 `referral_rules`（如 `abandonDays`），代码不写死数值；测试断言"等于配置值"，不断言魔数。
- **钱的铁律**：奖励仍是 `credits.grant` 的一笔 `referral_reward` 流水（幂等/有效期/FIFO 不另起炉灶）；本 spec 不新增任何直接动账代码，只动"发/不发"的闸门与配置面。
- 后台敏感写全部过 `requirePermission("config.write")` + `writeAudit`（现有 route 层已做，前端走同一端点即自动继承）。
- 校验从严不从宽：配置写入被拒（400）优于坏配置进库后发奖路径炸；**校验失败绝不部分写入**。
- TDD（bun:test 连真库经 mbp 隧道 `./test-on-mbp.sh`）；分支 `phase3/spec327-referral-closeout`；提交信息英文 Conventional Commits、账号 lookfree、**不加 Co-Authored-By**。
- admin 前端遵循 plans-client 现有模式（dirty 检测 / toast / 还原按钮 / 保存即时生效文案）。

## File Structure

```
apps/api/src/
├── routes/admin/plans.ts             # 改：PUT /configs/:key 对 referral_rules / reward_expire_days 加白名单形状校验
├── services/referral.ts              # 改：发奖前置「注册即弃」闸门（abandonDays>0 时生效）
├── services/referral-risk.ts         # 改：新增 assessAbandoned(inviteeId, abandonDays)（有效行为=积分消费或已支付订单）
└── config/billing-seed.ts            # 改：referral_rules 增 abandonDays: 0（0=关闭，默认不改变现行为）
apps/admin/components/admin/plans/
└── referral-config-card.tsx          # 新：邀请奖励配置卡（plans-client 内嵌区块，或拆子组件）
apps/api/test/
├── admin-plans-configs.test.ts       # 新/改：referral_rules 形状校验（好/坏输入、不部分写入、审计前后值）
├── referral-abandon.test.ts          # 新：注册即弃闸门（超期无消费→冻结+审计；有消费→照发；abandonDays=0→行为不变）
└── referral-reward.test.ts           # 改：回归确认新增闸门不影响既有发放用例
docs/superpowers/plans/phase-3/
└── spec307-referral-engine.md        # 改：按 Task 0 盘点结果如实勾选
```

## Interfaces

- **Consumes（按既有契约，不重实现）：**
  - `services/config` `getConfig/setConfig`；`routes/admin/plans.ts` 通用配置端点与审计。
  - `services/credits` 账本与 `payment_orders`（消费流水或已支付订单判定"有效行为"）。
  - `services/referral.ts` 现有 `bindByCode/onInviteeFirstPaid/grantRewards` 结构。
- **Produces：**
  - 后台「邀请奖励」配置卡（运营可视化改 `referral_rules` 全部键 + `reward_expire_days`）。
  - `referral_rules.abandonDays` 配置开关 + 发奖前置闸门。
  - 形状校验后的配置写入端点（对这两个键）。

## 配置键契约（后台价格菜单模块 · 本 spec 的编辑面）

`billing_configs` 键 `referral_rules`（嵌套 JSON，整体读写）：

| 字段 | 类型/约束 | 语义 |
|---|---|---|
| `inviterReward` | int ≥ 0 | 邀请人每单奖励积分 |
| `inviteeReward` | int ≥ 0 | 被邀请人奖励积分 |
| `unlockOn` | `""` \| `"invitee_first_paid"` | 空=被邀请人注册即发放；否则充值/开通会员即发放（充值/购买会员/续费付款单均触发） |
| `capPerUser` | int ≥ 0，且 ≥ max(inviterReward, inviteeReward) | 单用户 `referral_reward` 累计封顶；达上限 `reward_state=capped` |
| `riskMaxPerIpPerHour` | int ≥ 1 | 同 IP 1 小时绑定数阈值，超过冻结 |
| `abandonDays` | int ≥ 0（新增，默认 0=关闭） | 注册即弃判定：绑定超过 N 天且被邀请人无任何积分消费 → 冻结不发 |

独立键 `reward_expire_days`：int ≥ 0，奖励积分有效期（天）。

> 实名唯一校验：系统当前无实名体系，**本 spec 不实现假逻辑**；配置卡预留说明文案“实名校验待实名体系接入后启用”，不加假开关。

---

## Tasks

### Task 0 · spec307 盘点勾账（先核实再动代码）

- [x] `./test-on-mbp.sh test/referral-code.test.ts test/referral-reward.test.ts test/referral-risk.test.ts test/referral-routes.test.ts test/referral-wiring.test.ts` 跑通全部既有测试并记录结果。
- [x] 对照测试与代码，把 `spec307-referral-engine.md` 中**确已实现**的任务如实勾选；确不在的（如注册即弃）在该 spec 尾部补一行“遗留 → spec327”。
- [x] 提交：`docs(spec307): reconcile checkboxes with shipped implementation`。

### Task A · 配置写入形状校验（API，先测后码）

- [x] 测试：`admin-plans-configs.test.ts` —— ① `PUT /plans/configs/referral_rules` 合法五键+`abandonDays` → 200 且落库；② 缺键/负数/`unlockOn` 非法枚举/`capPerUser < max(两奖励)`/非对象 → 400 `invalid_input` 且**库值不变**；③ `reward_expire_days` 非负整数校验同理；④ 其它任意键不受影响（仍宽松直存）；⑤ 审计行带 before/after。
- [x] 实现：`routes/admin/plans.ts` 建 `CONFIG_SCHEMAS: Record<string, ZodSchema>` 白名单（`referral_rules`、`reward_expire_days`），命中则先校验再存；未命中键保持现行为。校验规则见上表（含跨字段 `capPerUser ≥ max` refine）。
- [x] mbp 全绿后提交：`feat(admin-api): shape-validate referral config keys`。

### Task B · 后台价格菜单「邀请奖励」配置卡（admin 前端）

- [x] `referral-config-card.tsx`：从 `GET /admin-api/plans/configs` 取 `referral_rules` + `reward_expire_days`；六个数值/枚举字段表单（`unlockOn` 用下拉：被邀请人注册即发放 / 充值/开通会员即发放；`abandonDays=0` 显示“关闭”提示）；本地校验与服务端同规则（提前拦，错误逐字段提示）。
- [x] 接入 `plans-client.tsx`：作为「套餐与积分口径配置」页新增区块（与现有卡片同风格）；dirty 检测、保存（两个 PUT，先 `referral_rules` 后 `reward_expire_days`，任一失败 toast 并保留编辑态）、还原按钮；保存成功 toast 文案注明“新规则即时生效，仅影响此后发放”。
- [x] 卡片底部只读提示区：当前封顶语义（达 `capPerUser` 后 `reward_state=capped` 不再发）、实名校验预留说明。
- [x] admin 测试（沿 `apps/admin` 现有测试基建）：表单校验拦截 + 保存请求体形状断言。
- [x] 提交：`feat(admin): referral reward config card in plans page`。

### Task C · 「注册即弃」风控闸门（API，先测后码）

- [x] 种子：`billing-seed.ts` 的 `referral_rules` 增 `abandonDays: 0`（幂等种子只补缺，不覆盖运营已改值）。
- [x] 测试：`referral-abandon.test.ts` —— ① `abandonDays=0`：既有行为逐字节不变（立即发/延迟解锁照旧）；② `abandonDays=N` 且绑定超 N 天、被邀请人**无任何有效行为（积分消费或已支付订单）** → 解锁触发时不发奖、`referrals` 冻结、`referral_risk_audits` 记 `abandoned`；③ 同条件但被邀请人有过消费 → 照发；④ 幂等：已冻结关系重复触发解锁不发不重复审计。
- [x] 实现：`referral-risk.ts` 增 `assessAbandoned(inviteeId, boundAt, abandonDays)`（有效行为 = 任意负向消费流水或任意已支付订单；查询走现有索引）；`referral.ts` 发奖入口（立即发放分支与 `onInviteeFirstPaid` 共用的 `grantRewards` 前置）接闸门。
- [x] 回归：`referral-reward.test.ts` 全绿（新增闸门默认关闭不影响既有用例）。
- [x] 提交：`feat(api): register-and-abandon gate for referral rewards`。

### Task D · 收尾

- [x] `./test-on-mbp.sh` 相关文件全量绿；`bun run typecheck`（api/admin）双绿。
- [x] `/code-review` 全修（钱相关从严）→ `/simplify`。
- [x] 合并 main + 推送；230 部署（api 原生构建 + admin 经 mbp buildx，流程见仓库部署备忘）。
- [x] 更新 `spec300-index.md`：追加 spec327 行（依赖 spec307/spec310）。

## 验收清单

- 运营在后台「套餐与积分口径配置」页可直接改：双方奖励额度、解锁条件、封顶、奖励有效期、同 IP 阈值、注册即弃天数——保存即生效、留审计。
- 坏配置（负数/坏枚举/封顶小于单次奖励）在 API 层被 400 拒绝，库值不变。
- `abandonDays>0` 时，注册即弃的被邀请关系不发奖、冻结留痕；`=0` 时行为与今天逐字节一致。
- spec307 文档勾选与代码一致；奖励发放全链路仍只经 `credits.grant`（幂等/过期/FIFO 同一套）。

## 变更记录

- 2026-07-22 语义修订（用户裁决终审遗留项）：「注册即弃」的**有效行为**由"仅积分消费"扩为**积分消费或任意已支付订单（首付即算）**。原因：延迟解锁的触发条件正是首付，付费触发解锁却被判「即弃」冻结自相矛盾。改动：`assessAbandoned` 增 `payment_orders.status='paid'` 存在性判定（`referral-abandon.test.ts` 用例③b 覆盖：超期无消费但有已支付订单 → 照常发放）；后台配置卡语义文案同步。
- 2026-07-22 产品口径落地（用户逐条确认）：①邀请关系不过期（abandonDays 保持 0=关闭）；②邀请积分不过期（`reward_expire_days` 种子与 230 线上值均改 0，历史带过期的奖励流水 0 条无需清洗）；③被邀请人奖励与注册赠送积分叠加（本就分属两笔独立入账，确认无需改动）；④发放时机文案定稿「被邀请人注册即发放 / 充值/开通会员即发放」（充值、购买会员、续费三类付款单均触发）。
