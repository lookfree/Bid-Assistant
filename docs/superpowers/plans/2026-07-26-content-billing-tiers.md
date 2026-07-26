# 标书生成「按总字数阶梯计费」实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把标书生成（`content` 步）的计费从「硬编码 2000 字 / 最长一章 / 固定两档」改为「运营后台可增删的字数阶梯 + 按本次产出正文总字数落档」，前端展示与后台配置同源联动。

**Architecture:** 新增独立定价服务 `content-pricing.ts`（纯函数校验/落档 + 一个读配置的 IO 函数），`billing-stub.ts` 只做编排。预扣取阶梯最大价、结算按总字数落档并钳到预扣额——只多退不少补。配置存 `billing_configs` 的 jsonb 键 `credit_cost.content_tiers`，后台阶梯编辑器与后端共用同一套校验规则。

**Tech Stack:** Hono 4.12 + Bun + Drizzle + PostgreSQL（apps/api）；Next.js 16 + React 19（apps/admin、apps/web）；测试 `bun test`。

设计文档：`docs/superpowers/specs/2026-07-26-content-billing-tiers-design.md`

## Global Constraints

- **钱的铁律**：所有积分变更只在 App API 内发生；每笔扣减/结算带幂等键（`hold:<stepId>` / `settle:<stepId>` / `release:<stepId>`）；金额一律整数；结算**只多退不少补**，`Math.min(落档价, heldAmount)` 的 clamp 不可删除。
- **缺口径即失败**：计费阶梯缺失或非法 → 抛错拒跑，**绝不回落默认值、绝不静默按 0 收费**。
- **不占步位不预扣**：阶梯校验必须发生在 `acquireStepSlot` 与 `preDeduct` **之前**（对齐现有 `model_not_configured` 口径）。
- **种子只初始化**：`seedConfigs()` 用 `onConflictDoNothing`，只写不存在的键，**绝不覆盖运营已调的值**。
- **前端不留静态副本**：所有档位数字来自后端实时配置；计费 CTA 只在确认态渲染，配置未到/加载中绝不亮计费按钮。
- **落档边界**：`总字数 ≤ maxChars` 落该档（等于阈值时落**较低**档）；`maxChars: null` 为顶档，有且只有一个，排序后必须在末位。
- 代码规范：单函数 ≤ 80 行、单文件 ≤ 800 行、关键方法带注释。
- 提交：英文 Conventional Commits，作者 `lookfree <etwuman@126.com>`，**禁止任何 Co-Authored-By / Claude 字样**。

## File Structure

| 文件 | 职责 |
|---|---|
| `apps/api/src/services/content-pricing.ts`（新建） | 阶梯的类型、校验、落档、预扣额；纯函数 + 一个读配置的 IO 函数 |
| `apps/api/test/services/content-pricing.test.ts`（新建） | 校验规则与落档边界的单测（不连库） |
| `apps/api/src/config/billing-seed.ts`（改） | 增加 `credit_cost.content_tiers` 初始阶梯 |
| `apps/api/src/services/step-finalize.ts`（改） | `maxChapterChars` → `totalChapterChars`（求和替代取最大） |
| `apps/api/src/services/credits.ts`（改） | `hold()` 支持显式 `amount` |
| `apps/api/src/services/billing-stub.ts`（改） | 删 `CONTENT_LONG_CHAR_THRESHOLD` / `holdOpForStep`，新增 `resolveStepHoldAmount`，`settleContent` 改按总字数 |
| `apps/api/src/routes/projects.ts`（改） | 预扣挂点接线（阶梯校验前置） |
| `apps/api/src/config/credit-cost-items.ts`（改） | 移除 `content_short` / `content_long` 两项 |
| `apps/api/src/services/membership.ts`（改） | 总览增加 `contentTiers` |
| `apps/api/src/routes/admin/plans.ts`（改） | `CONFIG_SCHEMAS` 增加 `credit_cost.content_tiers` 的 zod 校验 |
| `apps/admin/components/admin/plans/plans-client.tsx`（改） | 阶梯编辑器（增删档），移除两项旧旋钮 |
| `apps/web/lib/content-tiers.ts`（新建） | 阶梯 → 文案的纯函数（前端唯一格式化处） |
| `apps/web/test/content-tiers.test.ts`（新建） | 文案格式化单测 |
| `apps/web/app/(tool)/content/page.tsx`（改） | 两处计费文案改为按阶梯渲染 |
| `apps/web/app/(tool)/membership/page.tsx`（改） | 「积分消耗说明」增加标书生成阶梯行 |

---

### Task 1: 定价服务与初始阶梯

**Files:**
- Create: `apps/api/src/services/content-pricing.ts`
- Create: `apps/api/test/services/content-pricing.test.ts`
- Modify: `apps/api/src/config/billing-seed.ts`

**Interfaces:**
- Consumes: `getConfig` from `apps/api/src/services/config.ts`
- Produces:
  - `type ContentTier = { maxChars: number | null; cost: number }`
  - `CONTENT_TIERS_KEY: string`（值为 `"credit_cost.content_tiers"`）
  - `parseContentTiers(raw: unknown): ContentTier[]`（纯函数，非法抛错，返回升序且顶档在末位）
  - `costForChars(tiers: ContentTier[], totalChars: number): number`（纯函数）
  - `holdAmountFor(tiers: ContentTier[]): number`（纯函数）
  - `settleAmountFor(tiers: ContentTier[], totalChars: number, heldAmount: number): number`（纯函数，含防扣穿 clamp）
  - `contentTiers(): Promise<ContentTier[]>`（IO，读配置 + 校验）

- [ ] **Step 1: 写失败测试**

创建 `apps/api/test/services/content-pricing.test.ts`：

```ts
import { describe, it, expect } from "bun:test"
import {
  costForChars,
  holdAmountFor,
  parseContentTiers,
  settleAmountFor,
  type ContentTier,
} from "../../src/services/content-pricing"

const OK = [
  { maxChars: 50_000, cost: 40 },
  { maxChars: 150_000, cost: 80 },
  { maxChars: 300_000, cost: 150 },
  { maxChars: null, cost: 260 },
]

describe("parseContentTiers 校验（钱的输入，坏值必须拒跑）", () => {
  it("合法阶梯：升序返回且顶档在末位", () => {
    const t = parseContentTiers([{ maxChars: null, cost: 260 }, { maxChars: 150_000, cost: 80 }, { maxChars: 50_000, cost: 40 }])
    expect(t.map((x) => x.maxChars)).toEqual([50_000, 150_000, null])
    expect(t.map((x) => x.cost)).toEqual([40, 80, 260])
  })

  it("非数组 / 空数组 → 抛错", () => {
    expect(() => parseContentTiers(null)).toThrow()
    expect(() => parseContentTiers({})).toThrow()
    expect(() => parseContentTiers([])).toThrow()
  })

  it("cost 非法（负数 / 小数 / 缺失）→ 抛错", () => {
    expect(() => parseContentTiers([{ maxChars: null, cost: -1 }])).toThrow()
    expect(() => parseContentTiers([{ maxChars: null, cost: 1.5 }])).toThrow()
    expect(() => parseContentTiers([{ maxChars: null }])).toThrow()
  })

  it("maxChars 非法（0 / 负数 / 小数 / 字符串）→ 抛错", () => {
    expect(() => parseContentTiers([{ maxChars: 0, cost: 40 }, { maxChars: null, cost: 80 }])).toThrow()
    expect(() => parseContentTiers([{ maxChars: -5, cost: 40 }, { maxChars: null, cost: 80 }])).toThrow()
    expect(() => parseContentTiers([{ maxChars: 1.5, cost: 40 }, { maxChars: null, cost: 80 }])).toThrow()
    expect(() => parseContentTiers([{ maxChars: "5万", cost: 40 }, { maxChars: null, cost: 80 }])).toThrow()
  })

  it("没有顶档 / 多个顶档 → 抛错", () => {
    expect(() => parseContentTiers([{ maxChars: 50_000, cost: 40 }])).toThrow()
    expect(() => parseContentTiers([{ maxChars: null, cost: 40 }, { maxChars: null, cost: 80 }])).toThrow()
  })

  it("字数上限重复 → 抛错", () => {
    expect(() =>
      parseContentTiers([{ maxChars: 50_000, cost: 40 }, { maxChars: 50_000, cost: 80 }, { maxChars: null, cost: 90 }]),
    ).toThrow()
  })

  it("cost=0 是运营的显式决定，允许", () => {
    expect(() => parseContentTiers([{ maxChars: 50_000, cost: 0 }, { maxChars: null, cost: 80 }])).not.toThrow()
  })
})

describe("costForChars 落档（边界：等于阈值落较低档）", () => {
  const tiers: ContentTier[] = parseContentTiers(OK)
  it("各档命中", () => {
    expect(costForChars(tiers, 0)).toBe(40)
    expect(costForChars(tiers, 49_999)).toBe(40)
    expect(costForChars(tiers, 50_000)).toBe(40) // 恰好等于上限 → 落该（低）档
    expect(costForChars(tiers, 50_001)).toBe(80)
    expect(costForChars(tiers, 150_000)).toBe(80)
    expect(costForChars(tiers, 300_000)).toBe(150)
    expect(costForChars(tiers, 300_001)).toBe(260) // 超顶 → 顶档
    expect(costForChars(tiers, 10_000_000)).toBe(260)
  })
})

describe("holdAmountFor 预扣额", () => {
  it("取各档最大价（正常阶梯即顶档价）", () => {
    expect(holdAmountFor(parseContentTiers(OK))).toBe(260)
  })
  it("运营误配（中间档最贵）时仍取最大值，防结算少补扣穿", () => {
    const weird = parseContentTiers([{ maxChars: 50_000, cost: 400 }, { maxChars: null, cost: 100 }])
    expect(holdAmountFor(weird)).toBe(400)
  })
})

describe("settleAmountFor 结算额（落档价钳到预扣额）", () => {
  const tiers = parseContentTiers(OK)
  it("落档价低于预扣额 → 按落档价（多退）", () => {
    expect(settleAmountFor(tiers, 30_000, 260)).toBe(40)
  })
  it("落档价高于预扣额 → 钳到预扣额（绝不少补扣穿）", () => {
    expect(settleAmountFor(tiers, 400_000, 80)).toBe(80)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/api && bun test test/services/content-pricing.test.ts`
Expected: FAIL —— `Cannot find module '../../src/services/content-pricing'`

- [ ] **Step 3: 实现定价服务**

创建 `apps/api/src/services/content-pricing.ts`：

```ts
import { getConfig } from "./config"

/** 标书生成计费阶梯的一档。maxChars=null 表示顶档（无上限）。
 *  落档规则：本次产出正文总字数 ≤ maxChars 即取该档（等于阈值落较低档）。 */
export type ContentTier = { maxChars: number | null; cost: number }

export const CONTENT_TIERS_KEY = "credit_cost.content_tiers"

const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0
const isNonNegInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0

/** 逐档消毒：形状/类型不合法即抛错（钱的输入不做「尽力而为」的回落）。 */
function parseOne(t: unknown, i: number): ContentTier {
  if (!t || typeof t !== "object") throw new Error(`计费阶梯第 ${i + 1} 档不是对象`)
  const { maxChars, cost } = t as Record<string, unknown>
  if (!isNonNegInt(cost)) throw new Error(`计费阶梯第 ${i + 1} 档 cost 必须是 ≥0 的整数`)
  if (maxChars !== null && !isPosInt(maxChars)) throw new Error(`计费阶梯第 ${i + 1} 档 maxChars 必须是正整数或 null`)
  return { maxChars: (maxChars ?? null) as number | null, cost }
}

/** 校验并规范化阶梯（纯函数）：返回按字数上限升序、顶档在末位的数组。
 *  任一条不满足即抛错——坏配置必须拒跑，静默免费或错价都是资损。 */
export function parseContentTiers(raw: unknown): ContentTier[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`计费阶梯未配置或为空：${CONTENT_TIERS_KEY}`)
  const tiers = raw.map(parseOne)
  const tops = tiers.filter((t) => t.maxChars === null)
  if (tops.length !== 1) throw new Error("计费阶梯必须有且只有一个顶档（maxChars=null）")
  const bounded = tiers
    .filter((t) => t.maxChars !== null)
    .sort((a, b) => (a.maxChars as number) - (b.maxChars as number))
  for (let i = 1; i < bounded.length; i++) {
    if (bounded[i].maxChars === bounded[i - 1].maxChars) throw new Error("计费阶梯的字数上限不可重复")
  }
  return [...bounded, tops[0]]
}

/** 按总字数落档（纯函数）：升序取第一个满足 总字数 ≤ maxChars 的档，顶档兜底。 */
export function costForChars(tiers: ContentTier[], totalChars: number): number {
  for (const t of tiers) if (t.maxChars === null || totalChars <= t.maxChars) return t.cost
  return tiers[tiers.length - 1].cost
}

/** 预扣金额（纯函数）：取各档最大价。结算只多退不少补，取最大值可保证
 *  即使运营误配（中间档比顶档贵）也不会把结算算成少补而扣穿余额。 */
export function holdAmountFor(tiers: ContentTier[]): number {
  return Math.max(...tiers.map((t) => t.cost))
}

/** 结算金额（纯函数）：落档价钳到 ≤ 预扣额。这道 clamp 是防扣穿的最后一闸，
 *  也保证发版时「按旧价预扣的在途 run」能安全收尾（结算不会超过它已冻结的额度）。 */
export function settleAmountFor(tiers: ContentTier[], totalChars: number, heldAmount: number): number {
  return Math.min(costForChars(tiers, totalChars), heldAmount)
}

/** 读取运营配置的阶梯（IO）：缺失/非法一律抛错，由调用方转 400 拒跑。 */
export async function contentTiers(): Promise<ContentTier[]> {
  return parseContentTiers(await getConfig(CONTENT_TIERS_KEY))
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/api && bun test test/services/content-pricing.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 加入初始阶梯种子**

在 `apps/api/src/config/billing-seed.ts` 的 `BILLING_SEED` 对象里，紧跟在 `...creditCostSeed,` 之后插入：

```ts
  // 标书生成计费阶梯：按本次产出的正文总字数落档；maxChars=null 为顶档（无上限）。
  // 运营后台可增删档位；种子只在键缺失时写入（onConflictDoNothing），绝不覆盖运营已调的值。
  "credit_cost.content_tiers": [
    { maxChars: 50_000, cost: 40 },
    { maxChars: 150_000, cost: 80 },
    { maxChars: 300_000, cost: 150 },
    { maxChars: null, cost: 260 },
  ],
```

- [ ] **Step 6: 类型检查**

Run: `cd apps/api && bun run typecheck`
Expected: 无错误

- [ ] **Step 7: 提交**

```bash
git add apps/api/src/services/content-pricing.ts apps/api/test/services/content-pricing.test.ts apps/api/src/config/billing-seed.ts
git commit -m "feat(billing): add content pricing tiers service and seed"
```

---

### Task 2: 字数统计改为全书总字数

**Files:**
- Modify: `apps/api/src/services/step-finalize.ts:31`（`maxChapterChars` 函数与其调用点）
- Test: `apps/api/test/services/step-finalize-chars.test.ts`（新建）

**Interfaces:**
- Produces: `totalChapterChars(result: unknown): number` —— 供 Task 3 的结算调用
- 注意：同时**删除** `maxChapterChars`（无其它消费方；若 grep 出测试引用，一并改为 `totalChapterChars`）

- [ ] **Step 1: 写失败测试**

创建 `apps/api/test/services/step-finalize-chars.test.ts`：

```ts
import { describe, it, expect } from "bun:test"
import { totalChapterChars } from "../../src/services/step-finalize"

describe("totalChapterChars（本次产出正文总字数）", () => {
  it("多章求和，而不是取最长一章", () => {
    const result = { c1: "<p>" + "甲".repeat(1000) + "</p>", c2: "<p>" + "乙".repeat(1500) + "</p>" }
    expect(totalChapterChars(result)).toBe(2500)
  })

  it("剥掉 HTML 标签后再计数", () => {
    expect(totalChapterChars({ c1: '<h3 class="x">标题</h3><p>正文</p>' })).toBe(4)
  })

  it("非字符串值忽略；空/非对象返回 0", () => {
    expect(totalChapterChars({ c1: "四个字符", c2: null, c3: 42, c4: { a: 1 } })).toBe(4)
    expect(totalChapterChars(null)).toBe(0)
    expect(totalChapterChars("字符串")).toBe(0)
    expect(totalChapterChars({})).toBe(0)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/api && bun test test/services/step-finalize-chars.test.ts`
Expected: FAIL —— `totalChapterChars` 未导出

- [ ] **Step 3: 替换实现**

在 `apps/api/src/services/step-finalize.ts` 中，把 `maxChapterChars` 整个函数（含其上方注释）替换为：

```ts
/** content 步本次产出的正文总字数（剥 HTML 标签后各章求和）——决定落到哪个计费档。
 *  agent 的 _RESULT_KEY['content']='chapters'，故 run.result 即 { <章id>: html }。
 *  口径是「整本标书的总字数」，不是最长一章：一次 run 写完全部章节、只计一次费。 */
export function totalChapterChars(result: unknown): number {
  if (!result || typeof result !== "object") return 0
  let total = 0
  for (const v of Object.values(result as Record<string, unknown>)) {
    if (typeof v === "string") total += v.replace(/<[^>]+>/g, "").length
  }
  return total
}
```

同文件内的调用点（`settleAndAdvance` 里）把 `maxChapterChars(opts.result)` 改为 `totalChapterChars(opts.result)`。

- [ ] **Step 4: 清理其它引用**

Run: `cd apps/api && rg -n "maxChapterChars" src test`
Expected: 无输出。若有命中，逐处改为 `totalChapterChars`（语义已从「最长一章」变为「全书总和」，测试断言值需同步更新）。

- [ ] **Step 5: 运行测试确认通过**

Run: `cd apps/api && bun test test/services/step-finalize-chars.test.ts && bun run typecheck`
Expected: PASS + 类型无错误

- [ ] **Step 6: 提交**

```bash
git add apps/api/src/services/step-finalize.ts apps/api/test/services/step-finalize-chars.test.ts
git commit -m "feat(billing): bill content on total produced chars, not longest chapter"
```

---

### Task 3: 预扣与结算接线（钱的核心）

**Files:**
- Modify: `apps/api/src/services/credits.ts`（`hold()` 支持显式 amount）
- Modify: `apps/api/src/services/billing-stub.ts`（删旧常量与 `holdOpForStep`，新增 `resolveStepHoldAmount`，改 `settleContent` / `preDeduct`）
- Modify: `apps/api/src/routes/projects.ts`（预扣挂点，阶梯校验前置到占步位之前）
- Test: `apps/api/test/services/content-settle.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `contentTiers` / `costForChars` / `holdAmountFor`；Task 2 的 `totalChapterChars`
- Produces:
  - `resolveStepHoldAmount(step: string): Promise<number | undefined>` —— content 返回阶梯最大价，其余步返回 `undefined`
  - `settleContent(ref: string, holdId: string, heldAmount: number, totalChars: number): Promise<number>`
  - `preDeduct(userId: string, op: string, ref: string, amount?: number)` —— 新增第 4 参
  - **删除** `holdOpForStep` 与 `CONTENT_LONG_CHAR_THRESHOLD`

- [ ] **Step 1: 写失败测试（结算的钳制与落档）**

创建 `apps/api/test/services/content-settle.test.ts`。**测的是生产函数 `settleAmountFor`（Task 1 已导出），
不在测试里另写一份同样的算术**——否则测试只是在验证它自己。

```ts
import { describe, it, expect } from "bun:test"
import { holdAmountFor, parseContentTiers, settleAmountFor } from "../../src/services/content-pricing"

const TIERS = parseContentTiers([
  { maxChars: 50_000, cost: 40 },
  { maxChars: 150_000, cost: 80 },
  { maxChars: null, cost: 260 },
])

describe("content 结算口径 settleAmountFor", () => {
  it("按总字数落档后多退", () => {
    const held = holdAmountFor(TIERS) // 260
    expect(settleAmountFor(TIERS, 30_000, held)).toBe(40)
    expect(settleAmountFor(TIERS, 120_000, held)).toBe(80)
    expect(settleAmountFor(TIERS, 400_000, held)).toBe(260)
  })

  it("落档价高于预扣额时钳到预扣额（绝不少补扣穿）", () => {
    // 发版兼容场景：在途 run 是按旧 content_long=80 预扣的，而新顶档是 260
    expect(settleAmountFor(TIERS, 400_000, 80)).toBe(80)
    expect(settleAmountFor(TIERS, 120_000, 80)).toBe(80)
    expect(settleAmountFor(TIERS, 30_000, 80)).toBe(40) // 落档价低于预扣额时正常多退
  })

  it("预扣额为 0（异常兜底）时结算也为 0，不会变成负数补扣", () => {
    expect(settleAmountFor(TIERS, 400_000, 0)).toBe(0)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/api && bun test test/services/content-settle.test.ts`
Expected: 若 Task 1 已导出 `settleAmountFor` 则 PASS；若报 `settleAmountFor is not a function`，说明 Task 1
的 Step 3 漏了该函数，**回到 Task 1 补齐后再继续**（不要在本测试里自行实现算术绕过）。

- [ ] **Step 3: `hold()` 支持显式金额**

在 `apps/api/src/services/credits.ts` 中，把 `hold` 的签名与取值段改为：

```ts
export async function hold(
  userId: string,
  op: string,
  opts: { ref?: string; idempotencyKey: string; amount?: number },
): Promise<{ holdId: string; amount: number }> {
  // amount 显式给出 = 调用方（content 阶梯定价）已从运营配置解析出金额，此处不再查 credit_cost.<op>；
  // 其余步骤仍按配置键取值，「缺口径即失败」的不变量不破。
  let n: number
  if (opts.amount !== undefined) {
    if (!Number.isInteger(opts.amount) || opts.amount < 0) throw new Error(`预扣金额非法：${opts.amount}`)
    n = opts.amount
  } else {
    const configured = await getConfig<number>(`credit_cost.${op}`)
    if (configured == null) throw new Error(`未配置操作积分口径 credit_cost.${op}`) // 静默免费是资损，缺口径即失败
    n = Number(configured)
  }
  return await getDb().transaction(async (tx) => {
```

（函数体其余部分——锁行、幂等检查、余额校验、插 hold——**保持原样不动**。）

- [ ] **Step 4: 改造 billing-stub 编排**

在 `apps/api/src/services/billing-stub.ts`：

① 顶部 import 增加：

```ts
import { contentTiers, holdAmountFor, settleAmountFor } from "./content-pricing"
```

② **删除** `CONTENT_LONG_CHAR_THRESHOLD` 常量与 `holdOpForStep` 函数（含其注释），替换为：

```ts
/** 步 → 预扣金额。content 按计费阶梯的最大价预扣（结算只多退不少补）；
 *  其余步返回 undefined，表示按 credit_cost.<step> 取值（路径不变）。
 *  阶梯缺失/非法时抛错——调用方必须在「占步位/预扣之前」捕获并转 400，
 *  对齐 model_not_configured 口径：不占步位、不预扣、不静默按默认价扣费。 */
export async function resolveStepHoldAmount(step: string): Promise<number | undefined> {
  if (step !== "content") return undefined
  return holdAmountFor(await contentTiers())
}
```

③ 把 `settleContent` 整个替换为：

```ts
/** content 步结算：按本次产出的正文总字数落档，并钳到 ≤ heldAmount
 *  （防误配把结算算成少补 → 扣穿；也保证发版时在途 run 按旧预扣额安全收尾）。
 *  阶梯读取失败即抛错，绝不静默按 0 收费。返回实际计费额。 */
export async function settleContent(
  ref: string,
  holdId: string,
  heldAmount: number,
  totalChars: number,
): Promise<number> {
  const cost = settleAmountFor(await contentTiers(), totalChars, heldAmount)
  await ledgerSettle(holdId, cost, { idempotencyKey: `settle:${ref}` })
  return cost
}
```

④ `preDeduct` 增加可选金额透传：

```ts
/** 预扣：金额优先用显式 amount（content 阶梯），否则 N = credit_cost.<op>。
 *  余额不足返回 ok:false（业务态）；配置缺失等基建错误照抛。 */
export async function preDeduct(
  userId: string,
  op: string,
  ref: string,
  amount?: number,
): Promise<{ ok: boolean; holdId?: string; hold: number }> {
  try {
    const { holdId, amount: held } = await ledgerHold(userId, op, {
      ref,
      idempotencyKey: `hold:${ref}`,
      ...(amount !== undefined ? { amount } : {}),
    })
    return { ok: true, holdId, hold: held }
  } catch (e) {
    if (e instanceof InsufficientCreditsError) return { ok: false, hold: 0 }
    throw e
  }
}
```

- [ ] **Step 5: 结算调用点传总字数**

在 `apps/api/src/services/step-finalize.ts` 的 `settleAndAdvance` 中，确认 content 分支为（Task 2 已改函数名，此处核对参数语义）：

```ts
    cost = opts.step === "content"
      ? await b.settleContent(opts.stepId, opts.hold.holdId, opts.hold.heldAmount, totalChapterChars(opts.result))
      : await b.settle(opts.stepId, opts.hold.holdId, opts.hold.heldAmount)
```

- [ ] **Step 6: 路由挂点接线（阶梯校验前置）**

在 `apps/api/src/routes/projects.ts`，紧跟在 `if (!model) return c.json({ error: "model_not_configured" }, 400)` 之后、`acquireStepSlot` 之前插入：

```ts
    // content 计费阶梯同样「未配置即拒」，且必须在占步位/预扣之前——与上面 model_not_configured 一致：
    // 不占步位、不预扣、不静默按某个默认价扣费。
    let holdAmount: number | undefined
    try {
      holdAmount = await billing.resolveStepHoldAmount(step)
    } catch {
      return c.json({ error: "content_tiers_not_configured" }, 400)
    }
```

再把预扣那一行（原 `const hold = await preDeduct(userId, billing.holdOpForStep(step), s.id)`）改为：

```ts
    const hold = await preDeduct(userId, step, s.id, holdAmount)
```

并把其上方注释中「content 步预扣按上档 content_long（结算再落篇幅档）」一句改为「content 步预扣按计费阶梯最大价（结算再按产出总字数落档）」。

> 说明：账本 `op` 由 `content_long` 变为 `content`（更贴合「一次 run 整本计一次费」）。历史流水保留旧值，无需回填。

- [ ] **Step 7: 改既有 `billing-stub.test.ts` 的 content 用例**

`apps/api/test/billing-stub.test.ts` 现在 import 了将被删除的 `holdOpForStep`，且按旧「最长一章 / 两档」口径断言，**必然编译失败**。做两处改动：

① 第 3 行的 import 去掉 `holdOpForStep`：

```ts
import { preDeduct, settle, settleFailed, settleContent, resolveStepHoldAmount } from "../src/services/billing-stub"
```

② 把 `it("content 步按篇幅分档：…")` 整个用例替换为：

```ts
  it("content 步按产出总字数分档：预扣阶梯最大价，落档后多退", async () => {
    await setConfig("credit_cost.content_tiers", [
      { maxChars: 50_000, cost: 40 },
      { maxChars: 150_000, cost: 80 },
      { maxChars: null, cost: 260 },
    ])
    expect(await resolveStepHoldAmount("content")).toBe(260) // 预扣取最大价，防结算少补扣穿
    expect(await resolveStepHoldAmount("read")).toBeUndefined() // 其余步按 credit_cost.<step>
    await grant(userId, 600, { idempotencyKey: `gc-${userId}` })

    // 低档：总字数 3 万 → 结算 40，退 220
    const rS = await preDeduct(userId, "content", `refc1-${userId}`, 260)
    expect(rS.hold).toBe(260)
    expect(await settleContent(`refc1-${userId}`, rS.holdId!, rS.hold, 30_000)).toBe(40)

    // 顶档：总字数 40 万 → 足额 260
    const rL = await preDeduct(userId, "content", `refc2-${userId}`, 260)
    expect(await settleContent(`refc2-${userId}`, rL.holdId!, rL.hold, 400_000)).toBe(260)

    // 兼容：预扣额小于落档价（发版时的在途 run）→ 钳到预扣额，不扣穿
    const rOld = await preDeduct(userId, "content", `refc3-${userId}`, 80)
    expect(await settleContent(`refc3-${userId}`, rOld.holdId!, rOld.hold, 400_000)).toBe(80)
  })
```

（文件顶部 18-19 行原先 `setConfig("credit_cost.content_short", 40)` / `content_long` 两行可保留——它们对其它用例无害；本用例自带阶梯配置。）

- [ ] **Step 8: 全量类型检查 + 单测**

Run: `cd apps/api && bun run typecheck && bun test test/services/content-pricing.test.ts test/services/content-settle.test.ts test/services/step-finalize-chars.test.ts`
Expected: 类型无错误 + 三个测试文件全通过

（`billing-stub.test.ts` 连真库，留到 Task 8 的全量门禁里跑。）

- [ ] **Step 9: 提交**

```bash
git add apps/api/src/services/credits.ts apps/api/src/services/billing-stub.ts apps/api/src/services/step-finalize.ts apps/api/src/routes/projects.ts apps/api/test/services/content-settle.test.ts apps/api/test/billing-stub.test.ts
git commit -m "feat(billing): hold at tier max and settle content by total chars"
```

---

### Task 4: 口径清单与会员总览

**Files:**
- Modify: `apps/api/src/config/credit-cost-items.ts`（移除两项旧档）
- Modify: `apps/api/src/services/membership.ts`（总览增加 `contentTiers`）

**Interfaces:**
- Consumes: Task 1 的 `parseContentTiers` / `CONTENT_TIERS_KEY`
- Produces: `MembershipOverview.contentTiers: ContentTier[]` —— 供 Task 7 的 C 端渲染

- [ ] **Step 1: 移除失效的两项口径**

在 `apps/api/src/config/credit-cost-items.ts` 的 `CREDIT_COST_ITEMS` 数组中，**删除**这两行：

```ts
  { key: "content_short", feature: "标书生成（短篇）", desc: "单章 ≤ 2000 字", unit: "章", default: 40 },
  { key: "content_long", feature: "标书生成（长篇）", desc: "单章 > 2000 字", unit: "章", default: 80 },
```

并把文件顶部注释里的「9 项」改为「7 项」，追加一句：

```ts
// 标书生成不在此列表：它按「产出总字数阶梯」计费（credit_cost.content_tiers），见 services/content-pricing.ts。
```

> DB 里遗留的 `credit_cost.content_short` / `content_long` 两行**保留不删**（已无消费方，删除是不必要的破坏性操作）。

- [ ] **Step 2: 总览暴露阶梯**

在 `apps/api/src/services/membership.ts`：

① import 增加：

```ts
import { parseContentTiers, CONTENT_TIERS_KEY, type ContentTier } from "./content-pricing"
```

② 在 `MembershipOverview` 类型里，紧跟 `creditCosts` 那一行之后加：

```ts
  contentTiers: ContentTier[] // 标书生成计费阶梯（按产出总字数落档，运营后台可增删）；配置非法时为空数组
```

③ 在总览组装处（`const creditCosts = buildCreditCosts(costCfg)` 之后）加：

```ts
  // 展示路径对坏配置容错：非法阶梯返回空数组，由前端显示「未配置」而非编造价格；
  // 真正的拒跑发生在生成路径（resolveStepHoldAmount 抛错 → 400）。
  let contentTiers: ContentTier[] = []
  try {
    contentTiers = parseContentTiers(costCfg[CONTENT_TIERS_KEY])
  } catch {
    contentTiers = []
  }
```

④ 在 return 的对象里，`creditCosts,` 之后加 `contentTiers,`。

> `getConfigs("credit_cost.")` 已按前缀取全表，`credit_cost.content_tiers` 天然包含在 `costCfg` 里，无需额外查询。

- [ ] **Step 3: 修既有种子测试（口径项数与两项旧键）**

`apps/api/test/config-seed.test.ts:40-45` 现在断言 `credit_cost.*` 恰好 9 个键、且含 `content_short`=40 / `content_long`=80——本任务删掉两项后必然失败。把该用例替换为**按键断言**（不再数个数，从根上免疫「共享测试库残留孤儿键」导致的计数漂移）：

```ts
  it("getConfigs 前缀过滤：credit_cost.* 各项口径齐全（含计费阶梯）", async () => {
    const costs = await getConfigs("credit_cost.")
    for (const i of CREDIT_COST_ITEMS) expect(costs[`credit_cost.${i.key}`]).toBe(i.default)
    // 标书生成不在扁平口径里，走阶梯键（数组）
    expect(Array.isArray(costs["credit_cost.content_tiers"])).toBe(true)
  })
```

该文件顶部 import 增加：

```ts
import { CREDIT_COST_ITEMS } from "../src/config/credit-cost-items"
```

> 旧的 `content_short` / `content_long` 断言直接删除；DB 里的遗留行不清理（已无消费方）。

- [ ] **Step 4: 类型检查**

Run: `cd apps/api && bun run typecheck`
Expected: 无错误

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/config/credit-cost-items.ts apps/api/src/services/membership.ts apps/api/test/config-seed.test.ts
git commit -m "feat(billing): expose content tiers in membership overview"
```

---

### Task 5: 管理端写入校验

**Files:**
- Modify: `apps/api/src/routes/admin/plans.ts`（`CONFIG_SCHEMAS`）
- Test: `apps/api/test/routes/admin-content-tiers.test.ts`（新建）

**Interfaces:**
- Consumes: 既有 `PUT /admin-api/plans/configs/:key` 与 `CONFIG_SCHEMAS` 白名单机制
- Produces: 键 `credit_cost.content_tiers` 的服务端校验（与 Task 1 的 `parseContentTiers` 规则等价）

- [ ] **Step 1: 写失败测试**

创建 `apps/api/test/routes/admin-content-tiers.test.ts`：

```ts
import { describe, it, expect } from "bun:test"
import { CONFIG_SCHEMAS } from "../../src/routes/admin/plans"

const schema = () => CONFIG_SCHEMAS["credit_cost.content_tiers"]

describe("管理端阶梯写入校验", () => {
  it("合法阶梯放行", () => {
    expect(schema().safeParse([{ maxChars: 50_000, cost: 40 }, { maxChars: null, cost: 260 }]).success).toBe(true)
  })
  it("空数组 / 非数组拒绝", () => {
    expect(schema().safeParse([]).success).toBe(false)
    expect(schema().safeParse({}).success).toBe(false)
  })
  it("没有顶档 / 多个顶档拒绝", () => {
    expect(schema().safeParse([{ maxChars: 50_000, cost: 40 }]).success).toBe(false)
    expect(schema().safeParse([{ maxChars: null, cost: 40 }, { maxChars: null, cost: 80 }]).success).toBe(false)
  })
  it("字数上限重复拒绝", () => {
    expect(
      schema().safeParse([{ maxChars: 5_000, cost: 40 }, { maxChars: 5_000, cost: 80 }, { maxChars: null, cost: 90 }])
        .success,
    ).toBe(false)
  })
  it("非法数值拒绝（0/负/小数上限、负价、小数价）", () => {
    expect(schema().safeParse([{ maxChars: 0, cost: 40 }, { maxChars: null, cost: 80 }]).success).toBe(false)
    expect(schema().safeParse([{ maxChars: 1.5, cost: 40 }, { maxChars: null, cost: 80 }]).success).toBe(false)
    expect(schema().safeParse([{ maxChars: null, cost: -1 }]).success).toBe(false)
    expect(schema().safeParse([{ maxChars: null, cost: 1.5 }]).success).toBe(false)
  })
  it("未知键拒绝（防运营拼错字段名静默失效）", () => {
    expect(schema().safeParse([{ maxChars: null, cost: 40, price: 9 }]).success).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/api && bun test test/routes/admin-content-tiers.test.ts`
Expected: FAIL —— `CONFIG_SCHEMAS` 未导出 或 该键 schema 不存在

- [ ] **Step 3: 加 schema 并导出**

在 `apps/api/src/routes/admin/plans.ts` 的 `CONFIG_SCHEMAS` 对象里增加（与既有键并列）：

```ts
  // 标书生成计费阶梯：规则与 services/content-pricing.ts 的 parseContentTiers 等价，
  // 坏配置绝不落库（落库后生成路径会直接 400 拒跑，运营还以为改成功了）。
  "credit_cost.content_tiers": z
    .array(
      z
        .object({
          maxChars: z.number().int().positive().nullable(), // null = 顶档
          cost: z.number().int().nonnegative(),
        })
        .strict(),
    )
    .min(1)
    .refine((v) => v.filter((t) => t.maxChars === null).length === 1, { message: "need_exactly_one_top_tier" })
    .refine((v) => {
      const b = v.filter((t) => t.maxChars !== null).map((t) => t.maxChars as number)
      return new Set(b).size === b.length
    }, { message: "duplicate_max_chars" }),
```

同时把该对象的声明（`apps/api/src/routes/admin/plans.ts:20`）由 `const CONFIG_SCHEMAS: Record<string, z.ZodTypeAny> = {` 改为 `export const CONFIG_SCHEMAS: Record<string, z.ZodTypeAny> = {`——现在它未导出，测试需要直接校验规则（不必起 HTTP 服务）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/api && bun test test/routes/admin-content-tiers.test.ts && bun run typecheck`
Expected: PASS + 类型无错误

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/routes/admin/plans.ts apps/api/test/routes/admin-content-tiers.test.ts
git commit -m "feat(admin-api): validate content tier ladder on config write"
```

---

### Task 6: 后台阶梯编辑器

**Files:**
- Modify: `apps/admin/components/admin/plans/plans-client.tsx`

**Interfaces:**
- Consumes: Task 5 的写入校验；既有 `adminApi.plans.setConfig(key, value)`
- Produces: 后台「积分消耗口径」卡片下方的阶梯编辑区（增删档、顶档不可删）

- [ ] **Step 1: 移除两项失效旋钮**

在 `CREDIT_COST_OPS` 数组中**删除**这两行（对应键已从后端口径清单移除）：

```ts
  { key: "content_short", label: "标书生成（短篇）", desc: "单章 ≤ 2000 字" },
  { key: "content_long", label: "标书生成（长篇）", desc: "单章 > 2000 字" },
```

- [ ] **Step 2: 加类型与状态**

在 `type CreditCosts = Record<string, number>` 之后加：

```ts
/** 标书生成计费阶梯；maxChars=null 为顶档（无上限，不可删）。 */
type ContentTier = { maxChars: number | null; cost: number }

const DEFAULT_TIERS: ContentTier[] = [
  { maxChars: 50_000, cost: 40 },
  { maxChars: 150_000, cost: 80 },
  { maxChars: 300_000, cost: 150 },
  { maxChars: null, cost: 260 },
]

/** 阶梯合法性（与后端 parseContentTiers 同规则）：非法时就地报错、不发请求。 */
function tiersError(tiers: ContentTier[]): string | null {
  if (tiers.length === 0) return "至少要有一档"
  if (tiers.some((t) => !Number.isInteger(t.cost) || t.cost < 0)) return "积分必须是 ≥0 的整数"
  if (tiers.some((t) => t.maxChars !== null && (!Number.isInteger(t.maxChars) || t.maxChars <= 0)))
    return "字数上限必须是正整数"
  if (tiers.filter((t) => t.maxChars === null).length !== 1) return "必须有且只有一个顶档"
  const b = tiers.filter((t) => t.maxChars !== null).map((t) => t.maxChars as number)
  if (new Set(b).size !== b.length) return "字数上限不可重复"
  return null
}

/** 提交前规范化：按字数上限升序，顶档置于末位（与后端返回顺序一致）。 */
function sortTiers(tiers: ContentTier[]): ContentTier[] {
  const bounded = tiers.filter((t) => t.maxChars !== null).sort((a, b) => (a.maxChars as number) - (b.maxChars as number))
  return [...bounded, ...tiers.filter((t) => t.maxChars === null)]
}
```

在组件里，与 `costs` / `savedCosts` 并列增加状态：

```ts
  const [tiers, setTiers] = useState<ContentTier[] | null>(null)
  const [savedTiers, setSavedTiers] = useState<ContentTier[] | null>(null)
```

在载入配置处（`toCreditCosts(configs)` 附近）解析阶梯：

```ts
    const raw = configs["credit_cost.content_tiers"]
    const loaded = Array.isArray(raw) && raw.length > 0 ? (raw as ContentTier[]) : DEFAULT_TIERS
    setTiers(loaded)
    setSavedTiers(loaded)
```

- [ ] **Step 3: 保存时带上阶梯**

在 `save()` 里，把 `await Promise.all([` 的数组首项之前加入阶梯写入（仅在有改动时发请求）：

```ts
      const tiersChanged = tiers && JSON.stringify(tiers) !== JSON.stringify(savedTiers)
      if (tiersChanged) {
        const err = tiersError(tiers!)
        if (err) {
          setSaving(false)
          window.alert(`计费阶梯不合法：${err}`) // 非法绝不发请求，避免坏值落库后生成路径 400
          return
        }
      }
```

并在 `Promise.all` 数组中追加：

```ts
        ...(tiersChanged ? [adminApi.plans.setConfig("credit_cost.content_tiers", sortTiers(tiers!))] : []),
```

保存成功后同步 `setSavedTiers(sortTiers(tiers!))`（与既有 `setSavedCosts` 的处理放在一起）。

- [ ] **Step 4: 渲染编辑器**

在「积分消耗口径」`<Card>` 的 `</CardContent>` 之前，追加阶梯编辑区：

```tsx
                <div className="mt-6 border-t pt-4">
                  <div className="flex items-center justify-between">
                    <div className="flex flex-col">
                      <span className="text-sm font-medium text-foreground">标书生成（按产出总字数分档）</span>
                      <span className="text-xs text-muted-foreground">
                        一次生成整本标书计一次费；按实际产出的正文总字数落档（总字数 ≤ 上限即取该档）
                      </span>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setTiers((prev) => [...(prev ?? []), { maxChars: 10_000, cost: 10 }])
                      }
                    >
                      + 增加一档
                    </Button>
                  </div>
                  <div className="mt-3 flex flex-col gap-2">
                    {(tiers ?? []).map((t, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground">总字数 ≤</span>
                        {t.maxChars === null ? (
                          <span className="w-32 text-sm font-medium text-foreground">不限（顶档）</span>
                        ) : (
                          <Input
                            type="number"
                            className="h-9 w-32 text-right"
                            value={t.maxChars}
                            onChange={(e) =>
                              setTiers((prev) =>
                                (prev ?? []).map((x, j) =>
                                  j === i ? { ...x, maxChars: Math.trunc(Number(e.target.value)) || 0 } : x,
                                ),
                              )
                            }
                          />
                        )}
                        <span className="text-sm text-muted-foreground">字 →</span>
                        <Input
                          type="number"
                          className="h-9 w-24 text-right"
                          value={t.cost}
                          onChange={(e) =>
                            setTiers((prev) =>
                              (prev ?? []).map((x, j) =>
                                j === i ? { ...x, cost: Math.trunc(Number(e.target.value)) || 0 } : x,
                              ),
                            )
                          }
                        />
                        <span className="text-sm text-muted-foreground">积分</span>
                        {t.maxChars !== null && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setTiers((prev) => (prev ?? []).filter((_, j) => j !== i))}
                          >
                            删除
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                  {tiers && tiersError(tiers) && (
                    <p className="mt-2 text-xs font-medium text-destructive">{tiersError(tiers)}</p>
                  )}
                </div>
```

（`Button` 若尚未在本文件 import，从既有 UI 组件路径补上 import。）

- [ ] **Step 5: 构建验证**

Run: `cd apps/admin && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 6: 提交**

```bash
git add apps/admin/components/admin/plans/plans-client.tsx
git commit -m "feat(admin): add content billing tier ladder editor"
```

---

### Task 7: C 端展示联动

**Files:**
- Create: `apps/web/lib/content-tiers.ts`
- Create: `apps/web/test/content-tiers.test.ts`
- Modify: `apps/web/app/(tool)/content/page.tsx:104-105, 455, 799`
- Modify: `apps/web/app/(tool)/membership/page.tsx:353` 附近

**Interfaces:**
- Consumes: Task 4 的 `overview.contentTiers`
- Produces: `tiersCostText(tiers): string`、`fmtChars(n): string`（前端唯一的阶梯格式化处）

- [ ] **Step 1: 写失败测试**

创建 `apps/web/test/content-tiers.test.ts`：

```ts
import { describe, it, expect } from "bun:test"
import { tiersCostText, fmtTierChars, type ContentTier } from "../lib/content-tiers"

const TIERS: ContentTier[] = [
  { maxChars: 50_000, cost: 40 },
  { maxChars: 150_000, cost: 80 },
  { maxChars: 300_000, cost: 150 },
  { maxChars: null, cost: 260 },
]

describe("fmtTierChars", () => {
  it("万位取整/一位小数；不足一万按字", () => {
    expect(fmtTierChars(50_000)).toBe("5万")
    expect(fmtTierChars(150_000)).toBe("15万")
    expect(fmtTierChars(12_000)).toBe("1.2万")
    expect(fmtTierChars(8_000)).toBe("8000")
  })
})

describe("tiersCostText", () => {
  it("阶梯渲染为一句计费说明，顶档用「更多」", () => {
    expect(tiersCostText(TIERS)).toBe(
      "≤5万字 40 积分 · ≤15万字 80 积分 · ≤30万字 150 积分 · 更多 260 积分,按实际产出总字数分档结算",
    )
  })
  it("单顶档（未分档）也能渲染", () => {
    expect(tiersCostText([{ maxChars: null, cost: 99 }])).toBe("99 积分/次,按实际产出总字数分档结算")
  })
  it("空阶梯 → 明示未配置，绝不编造价格", () => {
    expect(tiersCostText([])).toBe("计费阶梯未配置,请联系运营")
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/web && bun test test/content-tiers.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现格式化**

创建 `apps/web/lib/content-tiers.ts`：

```ts
/** 标书生成计费阶梯（与后端 services/content-pricing.ts 的 ContentTier 同构）。
 *  maxChars=null 为顶档（无上限）。数值一律来自后端实时配置，前端不留静态副本。 */
export type ContentTier = { maxChars: number | null; cost: number }

/** 阈值的中文短写：5万 / 1.2万 / 8000。 */
export function fmtTierChars(n: number): string {
  if (n < 10_000) return String(n)
  const wan = n / 10_000
  return `${Number.isInteger(wan) ? wan : wan.toFixed(1)}万`
}

/** 阶梯 → 一句计费说明。空阶梯明示未配置，绝不编造价格。 */
export function tiersCostText(tiers: ContentTier[]): string {
  if (tiers.length === 0) return "计费阶梯未配置,请联系运营"
  const tail = ",按实际产出总字数分档结算"
  if (tiers.length === 1 && tiers[0].maxChars === null) return `${tiers[0].cost} 积分/次${tail}`
  const parts = tiers.map((t) =>
    t.maxChars === null ? `更多 ${t.cost} 积分` : `≤${fmtTierChars(t.maxChars)}字 ${t.cost} 积分`,
  )
  return `${parts.join(" · ")}${tail}`
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/web && bun test test/content-tiers.test.ts`
Expected: PASS

- [ ] **Step 5: 接线生成页两处文案**

在 `apps/web/app/(tool)/content/page.tsx`：

① 删除这两行：

```ts
  const contentShortCost = creditCostValue(overview, "content_short", 40)
  const contentLongCost = creditCostValue(overview, "content_long", 80)
```

替换为：

```ts
  /* 标书生成计费阶梯（按产出总字数分档，运营后台可增删）；文案与实际扣减同源，前端不写死 */
  const contentCostText = tiersCostText(overview?.contentTiers ?? [])
```

并在文件顶部 import 增加 `import { tiersCostText } from "@/lib/content-tiers"`。

② 把「投标正文尚未生成」卡片里的那句（原含「短章 … 积分/章、长章 … 积分/章」）改为：

```tsx
              AI 按提纲逐章撰写（{contentCostText}），生成后可在线编辑
```

③ 把 `GenerationConfigDialog` 的 `costText` 改为：

```tsx
          costText={contentCostText}
```

> 「/章」必须去掉：一次 run 由 agent 一口气写完全部章节，整本只计一次费，旧文案与实际扣减不符。

- [ ] **Step 6: 接线会员中心「积分消耗说明」**

在 `apps/web/app/(tool)/membership/page.tsx` 中，`{(overview?.creditCosts ?? []).map((c) => (` 这段列表渲染的**后面**，追加阶梯行（沿用同一行样式类名，与相邻条目视觉一致）：

```tsx
          {(overview?.contentTiers ?? []).length > 0 && (
            <div className="flex items-center justify-between py-2">
              <div className="flex flex-col">
                <span className="text-sm font-medium text-foreground">标书生成</span>
                <span className="text-xs text-muted-foreground">
                  整本按产出总字数分档，一次生成计一次费
                </span>
              </div>
              <span className="text-sm text-muted-foreground">
                {tiersCostText(overview!.contentTiers)}
              </span>
            </div>
          )}
```

并在该文件顶部 import 增加 `import { tiersCostText } from "@/lib/content-tiers"`。

- [ ] **Step 7: 类型检查与全量前端测试**

Run: `cd apps/web && node_modules/.bin/tsc --noEmit && bun test test/`
Expected: 类型无错误 + 全部测试通过

- [ ] **Step 8: 提交**

```bash
git add apps/web/lib/content-tiers.ts apps/web/test/content-tiers.test.ts "apps/web/app/(tool)/content/page.tsx" "apps/web/app/(tool)/membership/page.tsx"
git commit -m "feat(web): render content billing from the live tier ladder"
```

---

### Task 8: 合并门禁（连真库全量）

**Files:** 无代码改动

- [ ] **Step 1: 全量集成测试（经 mbp 隧道连真库）**

Run（脚本在**仓库根**，不在 `apps/api`）：`./test-on-mbp.sh`
Expected: 全绿。

> 已知例外：约 6 个积分账本测试在全量跑时因共享库脏数据恒失败（精确计数断言），main 上同样失败，非本次回归。判定方法：`git checkout main` 单跑那几个文件确认同样失败即可。**但本次改动动了钱**，这几个文件必须在本分支单独跑一遍并与 main 逐一比对，不得笼统跳过。

- [ ] **Step 2: 发版前查在途任务（铁律）**

Run: `ssh mbp "ssh angeek@192.168.106.230 'docker exec bid-api-1 bun /tmp/check-running.js'"`
Expected: `RUNNING_COUNT 0`。非 0 则等待或用 `stuck-steps.ts` 的 `failStepAndRefund` 自愈后再发版。

- [ ] **Step 3: 部署顺序**

本次改动涉及 api（钱）+ admin + web，**不涉及 agent、不涉及 DB 迁移**（`billing_configs` 是既有表）。

**⚠️ 关键：`seedConfigs()` 不在服务启动时自动跑**（实测校正：它只由 `bun run db:seed` 触发）。因此新键
**不会**随发版自动出现，而 `content` 步一旦读不到阶梯就 **400 `content_tiers_not_configured` 拒跑**。部署顺序必须是：

1. **先种键**：在目标环境执行 `docker exec bid-api-1 bun run db:seed`（幂等，`onConflictDoNothing`，不覆盖运营已调值）；
   或由运营先在后台「积分消耗口径」保存一次阶梯。
2. **验证键已存在**：查 `billing_configs` 中 `credit_cost.content_tiers` 非空，再继续。
3. **然后发 api**，最后发 admin / web（前端读到的 `contentTiers` 才非空）。

顺序颠倒的后果是「新 api 已上线但键没种」→ 用户点生成直接报错。发版前务必按上面 1→2→3 走。

---

## Self-Review

**Spec 覆盖核对**

| 设计文档章节 | 对应任务 |
|---|---|
| §3 配置契约（键名/类型/初始阶梯/校验规则） | Task 1（服务端校验 + 种子）、Task 5（写入校验） |
| §4 计费流程（预扣取 max、结算 clamp、总字数） | Task 2（总字数）、Task 3（预扣/结算/挂点） |
| §5 模块划分（content-pricing.ts 纯函数与 IO 分离） | Task 1 |
| §6 前端联动（overview 字段 + 两处文案 + 会员中心） | Task 4（后端字段）、Task 7（前端渲染） |
| §7 后台 UI（阶梯编辑器、同一套校验、审计） | Task 6（UI）、Task 5（服务端校验；审计由既有 `writeAudit` 自动覆盖） |
| §8 发版与兼容（在途安全、种子不覆盖、无迁移） | Task 3 Step 1 的 clamp 测试、Task 1 Step 5 种子、Task 8 部署顺序 |
| §9 测试要求 | Task 1/2/3/5/7 的单测 + Task 8 全量门禁 |
| §10 风险（误配、读取失败、用户困惑） | Task 5/6 双侧校验、Task 3 Step 6 的 400 拒跑、Task 7 文案 |

**类型一致性核对**：`ContentTier` 在 api（`content-pricing.ts`）与 web（`content-tiers.ts`）同构；`parseContentTiers` / `costForChars` / `holdAmountFor` / `contentTiers` / `resolveStepHoldAmount` / `settleContent` / `totalChapterChars` / `tiersCostText` / `fmtTierChars` 在定义任务与消费任务中命名一致。`preDeduct` 第 4 参 `amount?` 与 `hold` 的 `opts.amount` 对应。

**占位符扫描**：无 TBD/TODO；每个代码步骤均给出可直接落地的完整代码。
