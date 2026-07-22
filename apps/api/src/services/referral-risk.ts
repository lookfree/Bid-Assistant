import { and, eq, gte, sql } from "drizzle-orm"
import { getDb } from "../db/client"
import { referrals, referralRiskAudits, userIdentities, creditTransactions } from "../db/schema"
import type { Tx } from "./credits"

// 推荐防刷风控（spec307）：建关系前判定，命中即冻结（status=frozen 不进可发奖）+ 写审计留痕。
// 阈值全读配置（referral_rules.riskMaxPerIpPerHour），代码不写死。
// R4：判定须与建关系插入同一事务（bindByCode 持 deviceHash advisory 锁）——故收 db/tx 句柄，不自取 getDb()。

type Db = Tx | ReturnType<typeof getDb>

const IP_BURST_WINDOW_MS = 3_600_000 // 同 IP 集中判定窗口：最近 1 小时
const DAY_MS = 86_400_000

export type RiskVerdict = { frozen: boolean; reason?: string }

/** 风控判定（建关系前调，与插入同一事务）：设备查重 / 同 IP 段集中时段 / 手机号查重。 */
export async function assessRisk(
  db: Db,
  opts: { inviteeId: string; phone?: string; deviceHash?: string; ip?: string; maxPerIpPerHour: number },
): Promise<RiskVerdict> {
  // 设备查重：同设备指纹已参与过邀请 → 冻结
  if (opts.deviceHash) {
    const [d] = await db.select({ id: referrals.id }).from(referrals).where(eq(referrals.deviceHash, opts.deviceHash))
    if (d) return { frozen: true, reason: "duplicate_device" }
  }
  // 手机号查重：同手机号已有另一个账号被邀请过（换账号同手机薅） → 冻结
  if (opts.phone) {
    const dupPhone = await db
      .select({ id: referrals.id })
      .from(referrals)
      .innerJoin(userIdentities, eq(userIdentities.userId, referrals.inviteeId))
      .where(
        and(eq(userIdentities.provider, "phone"), eq(userIdentities.identifier, opts.phone), sql`${referrals.inviteeId} <> ${opts.inviteeId}`),
      )
      .limit(1)
    if (dupPhone.length > 0) return { frozen: true, reason: "duplicate_phone" }
  }
  // 同 IP 集中时段：最近 1 小时同 signup_ip 绑定数达阈值 → 冻结
  if (opts.ip) {
    const since = new Date(Date.now() - IP_BURST_WINDOW_MS)
    const [c] = await db
      .select({ n: sql<number>`count(*)` })
      .from(referrals)
      .where(and(eq(referrals.signupIp, opts.ip), gte(referrals.createdAt, since)))
    if (Number(c?.n ?? 0) >= opts.maxPerIpPerHour) return { frozen: true, reason: "same_ip_burst" }
  }
  return { frozen: false }
}

/**
 * 「注册即弃」判定（spec327 Task C，发奖前置闸门，与风控判定同一模块）：
 * 绑定超过 abandonDays 天，且该被邀请人从未产生任何负向消费流水（credit_transactions.amount<0，
 * 代表真实用过积分），才判定为白嫖注册刷奖励，应冻结不发。
 * abandonDays<=0 视为闸门关闭，不查库直接放行（配置语义 + 避免无谓查询）。
 * “超过 N 天”取严格大于——恰好 N 天整视为未超期，照发（边界照发，从宽不误伤）。
 *
 * 语义澄清（终审确认的设计意图）：这是**解锁有效期窗口**——「有效行为」只认积分消费，
 * 充值/首付本身不计入。延迟解锁模式下，被邀请人拖过窗口才首次付费的，付费触发解锁时同样
 * 命中本闸门（迟付费不补发）。方向恒为少发不多发（withhold），账本安全；后台配置卡已向
 * 运营明示该语义，默认 0=关闭。若业务日后要求「首付也算有效行为」，在此处扩判定条件。
 */
export async function assessAbandoned(inviteeId: string, boundAt: Date, abandonDays: number): Promise<boolean> {
  if (abandonDays <= 0) return false
  if (Date.now() - boundAt.getTime() <= abandonDays * DAY_MS) return false // 未超期
  // 只判存在性，limit 1 短路；走 credit_tx_user_idx（userId 索引），非全表扫描
  const [row] = await getDb()
    .select({ id: creditTransactions.id })
    .from(creditTransactions)
    .where(and(eq(creditTransactions.userId, inviteeId), sql`${creditTransactions.amount} < 0`))
    .limit(1)
  return !row
}

/** 冻结留痕：写风控审计（reason + detail 前后值）。 */
export async function freezeAndAudit(
  db: Db,
  opts: { referralId?: string; inviteeId: string; reason: string; detail?: Record<string, unknown> },
): Promise<void> {
  await db.insert(referralRiskAudits).values({ referralId: opts.referralId, inviteeId: opts.inviteeId, reason: opts.reason, detail: opts.detail ?? {} })
}
