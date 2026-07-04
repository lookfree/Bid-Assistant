import { randomInt } from "node:crypto"
import { and, eq, sql, isNotNull, inArray } from "drizzle-orm"
import { getDb } from "../db/client"
import { referralCodes, referrals, creditTransactions, paymentOrders } from "../db/schema"
import { getConfig, pickNonNegative } from "./config"
import { grant, lockUserBalanceRow, type Tx } from "./credits"
import { DuplicateInviteeError, InvalidCodeError, SelfReferralError } from "./referral-errors"
import { assessRisk, freezeAndAudit } from "./referral-risk"

// 推荐奖励引擎（架构 §6.2，spec307）：规则全配置化（referral_rules + reward_expire_days），代码不写死数值。
// 每用户唯一邀请码 → 被邀请人注册绑定 → 两段发放（立即/首付延迟解锁）→ 双方各得配置额度 → 封顶 capped → 风控冻结。
// 奖励是积分账本一笔 referral_reward 流水，走 spec302 credits.grant 的幂等键 + 有效期，不另起发放逻辑。

const DAY_MS = 86_400_000
// 去掉易混 O/0/I/1 的 6 位大写字母数字码
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

type ReferralRules = {
  inviterReward: number
  inviteeReward: number
  unlockOn: string // "" 立即发；"invitee_first_paid" 延迟解锁
  capPerUser: number
  riskMaxPerIpPerHour: number
}

async function getRules(): Promise<ReferralRules> {
  const r = await getConfig<ReferralRules>("referral_rules")
  if (!r) throw new Error("缺少 referral_rules 配置")
  return r
}

function genCode(len = 6): string {
  let s = ""
  for (let i = 0; i < len; i++) s += ALPHABET[randomInt(ALPHABET.length)] // 门控发钱绑定，用 crypto 随机（对齐 sms-code/auth 约定）
  return s
}

/** 每用户唯一一个邀请码：已有则返回，无则生成持久化（userId 主键幂等 + code 唯一冲突重试）。 */
export async function getMyCode(userId: string): Promise<string> {
  const db = getDb()
  const [exist] = await db.select().from(referralCodes).where(eq(referralCodes.userId, userId))
  if (exist) return exist.code
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = genCode()
    const [ins] = await db.insert(referralCodes).values({ userId, code }).onConflictDoNothing().returning()
    if (ins) return ins.code
    // 冲突：可能是 userId 已存在（并发）或 code 撞了——读回自己的，有则返回，无则换码重试
    const [again] = await db.select().from(referralCodes).where(eq(referralCodes.userId, userId))
    if (again) return again.code
  }
  throw new Error("生成邀请码失败（连续冲突）")
}

/** code → inviterId（无效码返回 undefined）。 */
export async function resolveInviter(code: string): Promise<string | undefined> {
  const [row] = await getDb().select({ userId: referralCodes.userId }).from(referralCodes).where(eq(referralCodes.code, code))
  return row?.userId
}

/** 该用户累计 referral_reward 正向奖励之和（封顶判定用；须在持锁事务内读，与发放同一串行化点）。 */
async function rewardedSoFar(tx: Tx, userId: string): Promise<number> {
  const [row] = await tx
    .select({ total: sql<number>`coalesce(sum(case when ${creditTransactions.amount} > 0 then ${creditTransactions.amount} else 0 end), 0)` })
    .from(creditTransactions)
    .where(and(eq(creditTransactions.userId, userId), eq(creditTransactions.type, "referral_reward")))
  return Number(row?.total ?? 0)
}

/** 给某用户发一笔奖励：封顶则把本条 referral 标 capped 并跳过；否则走 credits.grant（幂等键防重发）。
 *  返回是否实际发了。**只按 referralId 标 capped**，绝不批量刷该 inviter 名下其它关系。 */
async function grantReward(opts: {
  userId: string
  amount: number
  referralId: string
  role: "inviter" | "invitee"
  cap: number
  expireDays: number
}): Promise<boolean> {
  if (opts.amount <= 0) return false
  // 封顶读+发放收进同一事务同一把用户行锁（spec302 串行化点）：否则同一 inviter 多个被邀请人
  // 并发解锁会各自读到发放前的累计额、双双通过封顶判定而越发（两条 referralId 幂等键不同，防不住）。
  return await getDb().transaction(async (tx) => {
    await lockUserBalanceRow(tx, opts.userId)
    const already = await rewardedSoFar(tx, opts.userId)
    if (already + opts.amount > opts.cap) {
      // 封顶不在此标 capped：rewardState 是 referral 级单枚举，一方封顶写 capped 会覆盖另一方已发的 unlocked（R6）。
      // 交给 unlockAndReward 按「双方合并结果」统一置：任一方发出=unlocked，双方都封顶才=capped。
      return false
    }
    await grant(
      opts.userId,
      opts.amount,
      {
        type: "referral_reward",
        expireAt: opts.expireDays > 0 ? new Date(Date.now() + opts.expireDays * DAY_MS) : undefined,
        ref: `referral:${opts.referralId}`,
        idempotencyKey: `referral:${opts.referralId}:${opts.role}`, // 同关系同角色只发一次
      },
      tx,
    )
    return true
  })
}

/** 解锁并发双方奖励：给邀请人/被邀请人各发配置额度，任一方发出即置 reward_state=unlocked。 */
async function unlockAndReward(referralId: string): Promise<void> {
  const rules = await getRules()
  const expireDays = pickNonNegative(await getConfig<number>("reward_expire_days"), 0) // 钱相关：挡 NaN/负值静默采纳
  const [r] = await getDb().select().from(referrals).where(eq(referrals.id, referralId))
  if (!r || !r.inviteeId || r.rewardState !== "pending") return // 已解锁/封顶/无被邀请人 → 幂等返回

  const inviterPaid = await grantReward({ userId: r.inviterId, amount: rules.inviterReward, referralId, role: "inviter", cap: rules.capPerUser, expireDays })
  const inviteePaid = await grantReward({ userId: r.inviteeId, amount: rules.inviteeReward, referralId, role: "invitee", cap: rules.capPerUser, expireDays })
  // 合并结果决定 referral 级状态：任一方发出=unlocked；双方都封顶（或额度为 0）=capped（R6）。
  await getDb()
    .update(referrals)
    .set({ rewardState: inviterPaid || inviteePaid ? "unlocked" : "capped" })
    .where(eq(referrals.id, referralId))
}

/**
 * 注册时调：把被邀请人与邀请码绑定，建 referrals。
 * 顺序：解析码 → 自荐/无效码/重复绑定拦截 → 风控判定（命中建 frozen 关系 + 审计，不发奖）→
 *       非冻结时按配置走「立即发放」分支（unlockOn 为空则绑定即发；否则等首付延迟解锁）。
 */
export async function bindByCode(opts: {
  code: string
  inviteeId: string
  phone?: string
  deviceHash?: string
  ip?: string
}): Promise<{ referralId: string; rewarded: boolean; frozen: boolean }> {
  const inviterId = await resolveInviter(opts.code)
  if (!inviterId) throw new InvalidCodeError(opts.code)
  if (inviterId === opts.inviteeId) throw new SelfReferralError()
  const rules = await getRules()

  // 风控判定 + 建关系收进同一事务；持 deviceHash advisory 锁串行化「同设备」并发绑定（R4：否则 N 个
  // 并发绑定都在任一插入前读到零、全部通过风控）。发奖放事务外（grantReward 自带行锁，且需读已提交的关系行）。
  const { referralId, frozen } = await getDb().transaction(async (tx) => {
    if (opts.deviceHash) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${opts.deviceHash}))`)
    const [dup] = await tx.select({ id: referrals.id }).from(referrals).where(eq(referrals.inviteeId, opts.inviteeId))
    if (dup) throw new DuplicateInviteeError(opts.inviteeId)
    const verdict = await assessRisk(tx, {
      inviteeId: opts.inviteeId,
      phone: opts.phone,
      deviceHash: opts.deviceHash,
      ip: opts.ip,
      maxPerIpPerHour: rules.riskMaxPerIpPerHour,
    })
    const [ins] = await tx
      .insert(referrals)
      .values({
        inviterId,
        inviteeId: opts.inviteeId,
        code: opts.code,
        status: verdict.frozen ? "frozen" : "bound", // 冻结则不进入可发奖
        rewardState: "pending",
        deviceHash: opts.deviceHash,
        signupIp: opts.ip,
        frozenReason: verdict.reason,
      })
      .returning()
    if (verdict.frozen) {
      await freezeAndAudit(tx, { referralId: ins!.id, inviteeId: opts.inviteeId, reason: verdict.reason!, detail: { ip: opts.ip, deviceHash: opts.deviceHash } })
    }
    return { referralId: ins!.id, frozen: verdict.frozen }
  })

  if (frozen) return { referralId, rewarded: false, frozen: true }
  if (!rules.unlockOn) {
    await unlockAndReward(referralId) // 配置为立即发放
    return { referralId, rewarded: true, frozen: false }
  }
  return { referralId, rewarded: false, frozen: false }
}

/**
 * 被邀请人首次付费触发（**导出钩子**，供 spec304 markPaid 充值成功分支 + spec308 会员激活处调用）。
 * 仅当配置 unlockOn==="invitee_first_paid" 且该被邀请人有 bound+pending 关系时解锁发奖。
 * 幂等：reward_state 守卫（非 pending 直接返回）+ credits.grant 幂等键双重兜底；冻结关系（status!=bound）不发。
 */
export async function onInviteeFirstPaid(inviteeId: string): Promise<void> {
  const rules = await getRules()
  if (rules.unlockOn !== "invitee_first_paid") return
  const [r] = await getDb().select().from(referrals).where(eq(referrals.inviteeId, inviteeId))
  if (!r || r.status !== "bound" || r.rewardState !== "pending") return
  await unlockAndReward(r.id)
}

/**
 * 对账重扫（R3）：markPaid 里 onInviteeFirstPaid 是提交后 best-effort，抛错只 console.error，
 * 重试时 markPaid 已 already_final 不再触发 → pending 无人重扫、已挣得的奖励永久丢失。
 * Cron 定期扫「bound+pending 且被邀请人已有 paid 单」的关系，重驱钩子（幂等）兜底。返回处理条数。
 */
export async function sweepPendingReferralUnlocks(): Promise<number> {
  const rules = await getRules()
  if (rules.unlockOn !== "invitee_first_paid") return 0 // 立即发模式无 pending 待扫
  const db = getDb()
  const rows = await db
    .select({ inviteeId: referrals.inviteeId })
    .from(referrals)
    .where(
      and(
        eq(referrals.status, "bound"),
        eq(referrals.rewardState, "pending"),
        isNotNull(referrals.inviteeId),
        inArray(referrals.inviteeId, db.select({ id: paymentOrders.userId }).from(paymentOrders).where(eq(paymentOrders.status, "paid"))),
      ),
    )
  let n = 0
  for (const row of rows) {
    if (!row.inviteeId) continue
    await onInviteeFirstPaid(row.inviteeId) // 幂等：内部守卫 pending + credits.grant 幂等键
    n++
  }
  return n
}

/** 邀请列表 + 奖励状态（供 /api/referral/list 与会员中心 spec308）。 */
export async function listReferrals(
  inviterId: string,
): Promise<Array<{ inviteeId: string | null; status: string; rewardState: string; createdAt: Date }>> {
  return await getDb()
    .select({
      inviteeId: referrals.inviteeId,
      status: referrals.status,
      rewardState: referrals.rewardState,
      createdAt: referrals.createdAt,
    })
    .from(referrals)
    .where(eq(referrals.inviterId, inviterId))
    .orderBy(referrals.createdAt)
}
