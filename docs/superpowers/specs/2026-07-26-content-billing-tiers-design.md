# 标书生成计费改为「按总字数阶梯」· 设计

- 日期：2026-07-26
- 状态：设计已确认，待实现
- 影响面：`apps/api`（钱的权威层）、`apps/admin`（口径配置）、`apps/web`（展示与确认态）

## 1. 背景与问题

标书生成（`content` 步）现在的计费实现与对外口径**三处不一致**：

| | 现状 | 问题 |
|---|---|---|
| 分档依据 | `maxChapterChars`＝**最长那一章**的字数 > 2000 | 产品要的是**整本标书的总字数** |
| 阈值 2000 | **硬编码**在 `apps/api/src/services/billing-stub.ts` | 运营后台改不了 |
| 前端文案 | 「短章 40 积分/**章**、长章 80 积分/**章**」 | **与实际不符**：一次 run 由 agent 一口气写完全部章节，整本只收 40 或 80，不乘章数 |

档位也只有固定两档（`credit_cost.content_short` / `content_long`），而标书体量跨度是 2 万~50 万字，两档不足以覆盖。

## 2. 目标 / 非目标

**目标**
- 分档依据改为**本次生成的正文总字数**（剥 HTML 后各章之和）。
- 档位数量、每档阈值与价格全部由运营后台配置，**可增删**。
- 前端展示（生成配置弹层、会员中心积分消耗说明）与实际扣减口径**同源联动**。

**非目标**
- 不改其它步骤（read/outline/review/present/export/dedupe/rewrite）的计费方式。
- 不改预扣/结算/幂等的账本机制本身，只换 content 的「金额从哪来」。
- 不做历史订单/流水的重算或补退。

## 3. 配置契约

新增单一权威键（`billing_configs.value` 为 jsonb，天然支持数组）：

```
credit_cost.content_tiers
```

```ts
/** maxChars=null 表示顶档（无上限）。落档规则：总字数 ≤ maxChars 即取该档。 */
export type ContentTier = { maxChars: number | null; cost: number }
```

**初始种子（本次确认）**

| 档 | 条件 | 积分 |
|---|---|---|
| 1 | 总字数 ≤ 50,000 | 40 |
| 2 | ≤ 150,000 | 80 |
| 3 | ≤ 300,000 | 150 |
| 4 | > 300,000（顶档） | 260 |

**校验规则（钱的输入，必须严格；后端与后台共用同一套）**
1. 必须是**非空数组**。
2. 每档 `cost` 为**整数且 ≥ 0**；`maxChars` 为**正整数**或 `null`。
3. **有且只有一档** `maxChars === null`，且排序后必须是**最后一档**。
4. 非 null 的 `maxChars` **严格递增、互不相等**。
5. 任一条不满足 → **抛错拒跑**，绝不回落默认值、绝不静默按 0 收费（对齐现行「缺口径即失败，静默免费是资损」）。

`credit_cost.content_short` / `content_long` 从 `CREDIT_COST_ITEMS` 中移除（后台不再显示这两个已失效旋钮）。DB 里的旧行**保留不删**（无消费方，删除是不必要的破坏性操作）。

## 4. 计费流程

沿用现行两段扣费，只换金额来源：

```
预扣 hold  = max(所有档的 cost)        ← 不是「顶档价」，是最大值
生成 …
结算 settle = min(costForChars(总字数), heldAmount)   ← clamp 必须保留
```

- **为什么预扣取最大值**：结算只能**多退不能少补**（少补会扣穿余额）。取 `max` 而非顶档价，可在运营误配（中间档价 > 顶档价）时仍不扣穿。
- **`costForChars(tiers, total)`**：升序找第一个满足 `total <= maxChars`（null 视作 ∞）的档，返回其 `cost`。边界值恰好等于 `maxChars` 时**落入该（较低）档**。
- **`min(..., heldAmount)` clamp 保留**：这是防扣穿的最后一道闸，也是发版兼容的关键（见 §8）。
- 幂等键不变：`hold:<stepId>` / `settle:<stepId>` / `release:<stepId>`。

**字数统计** —— 把 `maxChapterChars` 改为 `totalChapterChars`：

```ts
/** content 步 run.result 形如 { <章id>: html }；剥标签后各章长度求和。 */
export function totalChapterChars(result: unknown): number
```

**预扣接线**：`hold()` 现在按 `credit_cost.<op>` 查数字。content 的金额来自阶梯，故给 `hold()` 增加可选的显式 `amount`（由 content 定价服务解析阶梯后传入，该服务自身对缺失/非法配置抛错，"缺口径即失败" 的不变量不破）。其余步骤路径完全不变。

## 5. 模块划分

新增 `apps/api/src/services/content-pricing.ts`（小而独立，便于单测）：

| 函数 | 职责 |
|---|---|
| `contentTiers()` | 读 `credit_cost.content_tiers` → 校验 → 升序返回；非法/缺失抛错 |
| `costForChars(tiers, total)` | 纯函数，按总字数落档 |
| `holdAmountFor(tiers)` | 纯函数，返回 `max(cost)` |

`billing-stub.ts` 只保留编排：`holdOpForStep` / `settleContent` 改为调用上述服务。纯函数与 IO 分离，校验和落档逻辑可脱离 DB 单测。

## 6. 前端联动（数字一律来自后端实时配置，不留静态副本）

- `/api/membership` 总览增加 `contentTiers` 字段。
- **生成配置弹层**（`apps/web/app/(tool)/content/page.tsx` 的 costText）：
  `生成 ≤5万字 40 积分 · ≤15万字 80 积分 · ≤30万字 150 积分 · 更多 260 积分，按实际产出总字数分档结算`
  （由阶梯渲染，去掉错误的「/章」）。
- **会员中心「积分消耗说明」**：原固定两行改为按阶梯渲染 N 行。
- 计费红线不变：**CTA 只在确认态渲染**，阶梯未到 / 加载中绝不亮计费按钮。

## 7. 后台 UI（`apps/admin`）

「积分消耗口径」中给标书生成单独一块**阶梯编辑器**：每行 `字数上限 + 积分`，可增删；顶档（无上限）不可删。保存前跑与后端**同一套校验**，非法时就地报错、不发请求。写入走既有 `PUT /admin-api/plans/configs/:key`（需放行该键的数组值并做同样校验），并按既有约定写审计。

## 8. 发版与兼容

- **在途 content 步是安全的**：发版前已按铁律查 `project_steps status='running'`；即便有在途 run，其 hold 是按旧 `content_long`(80) 预扣的，结算走新逻辑后 `cost = min(新档价, 80) ≤ 80`，**不会扣穿**。这正是 §4 clamp 必须保留的原因。
- **种子不得覆盖运营改动**（运营后续会自行调阶梯，这是硬要求）：把新键加进 `BILLING_SEED` 即可——
  `seedConfigs()` 用的是 `insert(...).onConflictDoNothing({target: key})`，**仅写不存在的键**，
  重复部署不会回滚后台已调的阶梯（现网 `signup_grant_credits` 种子为 200、实际生效 500，即为此机制的实证）。
  运营侧的写入走 `setConfig()`（upsert），两条路径不冲突。
- 无 DB 迁移（`billing_configs` 是既有表，值为 jsonb）。

## 9. 测试要求

- **纯函数单测**：校验规则逐条命中（空数组 / cost 非整数 / 无顶档 / 多个顶档 / 阈值不递增 / 顶档不在末位）；`costForChars` 边界（恰好 = maxChars 落低档、0 字、超顶档）；`holdAmountFor` 在误配（中间档最贵）时仍取最大值。
- **结算单测**：`settleContent` 的 clamp（新档价 > heldAmount 时按 heldAmount）、幂等重放。
- **字数统计单测**：`totalChapterChars` 求和、剥 HTML、非字符串值忽略。
- 前端：阶梯 → 文案渲染的单测。
- 全量走 `./test-on-mbp.sh`（连真库）作为合并门禁。

## 10. 风险

| 风险 | 处置 |
|---|---|
| 运营误配阶梯导致收费异常 | 严格校验 + 后台就地报错；预扣取 `max(cost)` |
| 阶梯读取失败使生成不可用 | 明确抛错并给可读文案（同 `model_not_configured` 口径：不占步位、不预扣） |
| 新旧口径切换期用户困惑 | 前端文案直述阈值与「按实际产出总字数分档结算」 |
