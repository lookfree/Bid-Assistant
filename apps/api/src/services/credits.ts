import { and, eq, isNotNull, lte, sql } from "drizzle-orm"
import { getDb } from "../db/client"
import { creditTransactions, creditBalances } from "../db/schema"
import { getConfig } from "./config"
import { InsufficientCreditsError } from "./credits-errors"

// 积分账本引擎（架构 §5/§6、规格第五节）：
// 余额 = Σ credit_transactions.amount（append-only），credit_balances 仅缓存+对账。
// AI 操作两段式：hold(-N 预扣) → settle(多退少补) / release(全额退还)；全部带幂等键（DB 唯一约束兜底）。
// 钱只在 App 层动；智能体只上报 usage（§3.2）。

/** 余额 = Σ流水；顺带刷新 credit_balances 缓存。 */
export async function getBalance(userId: string): Promise<number> {
  const [row] = await getDb()
    .select({ total: sql<number>`coalesce(sum(${creditTransactions.amount}), 0)` })
    .from(creditTransactions)
    .where(eq(creditTransactions.userId, userId))
  const balance = Number(row?.total ?? 0)
  await getDb()
    .insert(creditBalances)
    .values({ userId, balance })
    .onConflictDoUpdate({ target: creditBalances.userId, set: { balance, updatedAt: new Date() } })
  return balance
}

/** 入账：赠送/充值/推荐奖励（带有效期批次与幂等键；重复入账被唯一约束忽略）。 */
export async function grant(
  userId: string,
  amount: number,
  opts: {
    type?: "grant" | "purchase" | "referral_reward"
    sourceBatch?: string
    expireAt?: Date
    ref?: string
    idempotencyKey: string
  },
): Promise<void> {
  if (amount <= 0) throw new Error(`grant 金额必须为正：${amount}`) // 钱从严：入账不允许 0/负
  await getDb()
    .insert(creditTransactions)
    .values({
      userId,
      type: opts.type ?? "grant",
      amount,
      sourceBatch: opts.sourceBatch,
      expireAt: opts.expireAt,
      ref: opts.ref,
      idempotencyKey: opts.idempotencyKey,
    })
    .onConflictDoNothing({ target: creditTransactions.idempotencyKey })
  await getBalance(userId)
}

/** 预扣：N = credit_cost.<op> 配置。事务内锁 credit_balances 用户行作串行化点，
 *  校验余额≥N 后写 hold(-N)。余额不足抛 InsufficientCreditsError。
 *  为什么锁用户行而非流水行：新用户首扣时 credit_transactions 无行可锁（谓词锁缺口），
 *  并发首扣会各自读到余额再一起插 hold → 超扣；先 upsert 兜底建行保证有行可锁。 */
export async function hold(
  userId: string,
  op: string,
  opts: { ref?: string; idempotencyKey: string },
): Promise<{ holdId: string; amount: number }> {
  const configured = await getConfig<number>(`credit_cost.${op}`)
  if (configured == null) throw new Error(`未配置操作积分口径 credit_cost.${op}`) // 静默免费是资损，缺口径即失败
  const n = Number(configured)
  return await getDb().transaction(async (tx) => {
    // 幂等：同 key 已 hold 过 → 返回原记录（重试/重复请求不重复扣）
    const [exist] = await tx
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.idempotencyKey, opts.idempotencyKey))
    if (exist) return { holdId: exist.id, amount: -exist.amount }

    // —— 并发超扣串行化点：锁该用户在 credit_balances 的行 ——
    await tx.insert(creditBalances).values({ userId, balance: 0 }).onConflictDoNothing({ target: creditBalances.userId })
    await tx.execute(sql`select 1 from ${creditBalances} where ${creditBalances.userId} = ${userId} for update`)

    // 持锁后再算余额、校验、插 hold —— 同 userId 的并发 hold 在此串行排队
    const [row] = await tx
      .select({ total: sql<number>`coalesce(sum(${creditTransactions.amount}), 0)` })
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, userId))
    const available = Number(row?.total ?? 0)
    if (available < n) throw new InsufficientCreditsError(n, available)

    const [ins] = await tx
      .insert(creditTransactions)
      .values({ userId, type: "hold", amount: -n, ref: opts.ref, idempotencyKey: opts.idempotencyKey })
      .returning()
    // 持锁期间顺带刷新缓存（余额已知，免出锁后再全表求和）
    await tx
      .update(creditBalances)
      .set({ balance: available - n, updatedAt: new Date() })
      .where(eq(creditBalances.userId, userId))
    return { holdId: ins!.id, amount: n }
  })
}

/** 失败全额退还：对 holdId 写 release(+N)，净=0。幂等；holdId 非 hold 类型则 no-op。 */
export async function release(holdId: string, opts: { idempotencyKey: string }): Promise<void> {
  const [h] = await getDb().select().from(creditTransactions).where(eq(creditTransactions.id, holdId))
  if (!h || h.type !== "hold") return
  await getDb()
    .insert(creditTransactions)
    .values({ userId: h.userId, type: "release", amount: -h.amount, ref: h.ref, idempotencyKey: opts.idempotencyKey })
    .onConflictDoNothing({ target: creditTransactions.idempotencyKey })
  await getBalance(h.userId)
}

/** 结算：对 holdId(已预扣 N) 按实际用量结算，净消耗=actualCost。
 *  写 settle(N - actualCost)：actualCost<N 退差额；>N 补扣（amount 为负）。幂等。 */
export async function settle(holdId: string, actualCost: number, opts: { idempotencyKey: string }): Promise<void> {
  if (actualCost < 0) throw new Error(`结算用量不能为负：${actualCost}`)
  const [h] = await getDb().select().from(creditTransactions).where(eq(creditTransactions.id, holdId))
  if (!h || h.type !== "hold") return
  const held = -h.amount // N
  const adjust = held - actualCost // 多退(>0)/少补(<0)
  await getDb()
    .insert(creditTransactions)
    .values({ userId: h.userId, type: "settle", amount: adjust, ref: h.ref, idempotencyKey: opts.idempotencyKey })
    .onConflictDoNothing({ target: creditTransactions.idempotencyKey })
  await getBalance(h.userId)
}

/** 过期：扫 expire_at<=now 的入账批次，把「未被已落地消耗抵扣的余量」写 expire 注销（FIFO 先过期先扣）。
 *  返回本次过期总额；spec306 的 Cron 调用。 */
export async function expireDue(now: Date): Promise<number> {
  const users = await getDb()
    .selectDistinct({ userId: creditTransactions.userId })
    .from(creditTransactions)
    .where(and(isNotNull(creditTransactions.expireAt), lte(creditTransactions.expireAt, now)))
  let total = 0
  for (const { userId } of users) {
    total += await expireUser(userId, now)
  }
  return total
}

/** 已落地消耗口径（正数）：expire/refund_clawback 直接累计；
 *  hold/settle/release 按 ref 分组，组内含 settle/release 才算落地（取净额的负数部分）；
 *  在途裸 hold 不计——否则高估消耗导致漏过期。 */
function landedConsumption(rows: Array<{ id: string; type: string; amount: number; ref: string | null }>): number {
  let consumed = 0
  const groups = new Map<string, { settled: boolean; net: number }>()
  for (const r of rows) {
    if ((r.type === "expire" || r.type === "refund_clawback") && r.amount < 0) {
      consumed += -r.amount
      continue
    }
    if (!["hold", "settle", "release"].includes(r.type)) continue
    const key = r.ref ?? r.id
    const g = groups.get(key) ?? { settled: false, net: 0 }
    g.net += r.amount
    if (r.type === "settle" || r.type === "release") g.settled = true
    groups.set(key, g)
  }
  for (const [, g] of groups) if (g.settled && g.net < 0) consumed += -g.net
  return consumed
}

/** 单用户过期结转（事务内，锁用户行与 hold 同一串行化点，防与并发扣减交错）。
 *  FIFO 台账口径：
 *  - 消耗只计「已落地」负流水：settle 的净扣部分、既往 expire、refund_clawback；
 *  - **排除在途 hold**（未配对 settle/release 前不算消耗，否则高估消耗 → 漏过期）；
 *  - 消耗从最早到期批次起抵扣，到期批次的剩余 → expire(-剩余)，幂等键 expire:<grantId>。 */
async function expireUser(userId: string, now: Date): Promise<number> {
  return await getDb().transaction(async (tx) => {
    await tx.insert(creditBalances).values({ userId, balance: 0 }).onConflictDoNothing({ target: creditBalances.userId })
    await tx.execute(sql`select 1 from ${creditBalances} where ${creditBalances.userId} = ${userId} for update`)

    const grants = await tx
      .select()
      .from(creditTransactions)
      .where(
        and(eq(creditTransactions.userId, userId), isNotNull(creditTransactions.expireAt), sql`${creditTransactions.amount} > 0`),
      )
      .orderBy(creditTransactions.expireAt) // 先过期的在前
    const rows = await tx
      .select({
        id: creditTransactions.id,
        type: creditTransactions.type,
        amount: creditTransactions.amount,
        ref: creditTransactions.ref,
      })
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, userId))
    let consumed = landedConsumption(rows)

    let expired = 0
    for (const g of grants) {
      const consumedFromThis = Math.min(consumed, g.amount)
      const live = g.amount - consumedFromThis // 该批被已落地消耗抵扣后的剩余
      consumed -= consumedFromThis
      if (g.expireAt && g.expireAt <= now && live > 0) {
        const inserted = await tx
          .insert(creditTransactions)
          .values({
            userId,
            type: "expire",
            amount: -live,
            sourceBatch: g.sourceBatch ?? g.id,
            idempotencyKey: `expire:${g.id}`,
          })
          .onConflictDoNothing({ target: creditTransactions.idempotencyKey })
          .returning()
        if (inserted.length > 0) expired += live // 幂等命中（已过期过）不重复计
      }
    }
    if (expired > 0) {
      const [row] = await tx
        .select({ total: sql<number>`coalesce(sum(${creditTransactions.amount}), 0)` })
        .from(creditTransactions)
        .where(eq(creditTransactions.userId, userId))
      await tx
        .update(creditBalances)
        .set({ balance: Number(row?.total ?? 0), updatedAt: new Date() })
        .where(eq(creditBalances.userId, userId))
    }
    return expired
  })
}
