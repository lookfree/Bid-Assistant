import { describe, it, expect, beforeEach, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { getDb, closeDb } from "../src/db/client"
import { users, referrals, creditTransactions, referralRiskAudits, paymentOrders } from "../src/db/schema"
import { getMyCode, bindByCode, onInviteeFirstPaid } from "../src/services/referral"
import { getBalance } from "../src/services/credits"
import { seedConfigs, setConfig } from "../src/services/config"
import { makeLedgerUser, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/referral-abandon.test.ts）

const DAY_MS = 86_400_000
const madeUsers: string[] = []
const mkUser = () => makeLedgerUser((id) => madeUsers.push(id))
// abandonDays=2：绑定超 2 天且无消费流水才判定放弃；测试用小天数便于伪造边界时间戳
const RULES = { inviterReward: 50, inviteeReward: 50, unlockOn: "invitee_first_paid", capPerUser: 500, riskMaxPerIpPerHour: 20, abandonDays: 2 }

beforeEach(async () => {
  await seedConfigs()
  await setConfig("referral_rules", RULES)
})
afterAll(async () => {
  await setConfig("referral_rules", RULES)
  for (const id of madeUsers) await getDb().delete(users).where(eq(users.id, id))
  await closeDb()
})

// 把 referrals.created_at 改到 N 天前（±buffer 毫秒，避免与判定时刻的边界竞态导致测试抖动）。
async function backdate(referralId: string, msAgo: number): Promise<void> {
  await getDb().update(referrals).set({ createdAt: new Date(Date.now() - msAgo) }).where(eq(referrals.id, referralId))
}

// 模拟被邀请人产生过一笔真实消费（任意负向流水）。
async function markConsumed(userId: string): Promise<void> {
  await getDb()
    .insert(creditTransactions)
    .values({ userId, type: "hold", amount: -1, idempotencyKey: `test-consume-${userId}-${Date.now()}` })
}

// 模拟被邀请人有一笔已支付订单（首付也算有效行为：与消费流水并列的第二种判定依据）。
async function markPaidOrder(userId: string): Promise<void> {
  await getDb().insert(paymentOrders).values({
    userId,
    type: "recharge",
    amountCents: 100,
    status: "paid",
    clientSn: `test-abandon-${userId}-${Date.now()}`,
    idempotencyKey: `test-abandon-${userId}-${Date.now()}`,
  })
}

const rewardRow = (referralId: string, role: string) =>
  getDb().select().from(creditTransactions).where(eq(creditTransactions.idempotencyKey, `referral:${referralId}:${role}`))

describe("spec327 Task C 「注册即弃」风控闸门（发奖前置，双方共同路径）", () => {
  it("① abandonDays=0：闸门关闭，绑定远超期且无消费也照常延迟解锁发奖", async () => {
    await setConfig("referral_rules", { ...RULES, abandonDays: 0 })
    const inviter = await mkUser()
    const invitee = await mkUser()
    const { referralId } = await bindByCode({ code: await getMyCode(inviter), inviteeId: invitee })
    await backdate(referralId, 999 * DAY_MS) // 远超任何合理天数，验证闸门关闭时压根不查
    await onInviteeFirstPaid(invitee)
    expect(await getBalance(inviter)).toBe(RULES.inviterReward)
    expect(await getBalance(invitee)).toBe(RULES.inviteeReward)
    const [rel] = await getDb().select().from(referrals).where(eq(referrals.id, referralId))
    expect(rel!.status).toBe("bound")
    expect(rel!.rewardState).toBe("unlocked")
  })

  it("① 配置缺 abandonDays 字段（老库行）：兜底按 0 处理，照常发放", async () => {
    const { abandonDays: _drop, ...withoutField } = RULES
    await setConfig("referral_rules", withoutField)
    const inviter = await mkUser()
    const invitee = await mkUser()
    const { referralId } = await bindByCode({ code: await getMyCode(inviter), inviteeId: invitee })
    await backdate(referralId, 999 * DAY_MS)
    await onInviteeFirstPaid(invitee)
    expect(await getBalance(inviter)).toBe(RULES.inviterReward)
    const [rel] = await getDb().select().from(referrals).where(eq(referrals.id, referralId))
    expect(rel!.status).toBe("bound")
  })

  it("② 超过 abandonDays 且被邀请人既无消费流水也无已支付订单 → 不发奖、冻结关系、审计 reason=abandoned", async () => {
    const inviter = await mkUser()
    const invitee = await mkUser()
    const { referralId } = await bindByCode({ code: await getMyCode(inviter), inviteeId: invitee })
    await backdate(referralId, RULES.abandonDays * DAY_MS + 60_000) // 超期 1 分钟余量，避免边界抖动
    await onInviteeFirstPaid(invitee)
    expect(await getBalance(inviter)).toBe(0)
    expect(await getBalance(invitee)).toBe(0)
    const [rel] = await getDb().select().from(referrals).where(eq(referrals.id, referralId))
    expect(rel!.status).toBe("frozen")
    expect(rel!.frozenReason).toBe("abandoned")
    expect(rel!.rewardState).toBe("pending") // 只冻结，不误标 unlocked/capped
    const audits = await getDb().select().from(referralRiskAudits).where(eq(referralRiskAudits.referralId, referralId))
    expect(audits.length).toBe(1)
    expect(audits[0]!.reason).toBe("abandoned")
  })

  it("③ 同条件但被邀请人有过一笔消费流水 → 视为有效用户，照常发放", async () => {
    const inviter = await mkUser()
    const invitee = await mkUser()
    const { referralId } = await bindByCode({ code: await getMyCode(inviter), inviteeId: invitee })
    await backdate(referralId, RULES.abandonDays * DAY_MS + 60_000)
    await markConsumed(invitee)
    await onInviteeFirstPaid(invitee)
    const [rel] = await getDb().select().from(referrals).where(eq(referrals.id, referralId))
    expect(rel!.status).toBe("bound")
    expect(rel!.rewardState).toBe("unlocked")
    expect((await rewardRow(referralId, "inviter")).length).toBe(1)
    expect((await rewardRow(referralId, "invitee")).length).toBe(1)
  })

  it("③b 超期无消费但有已支付订单（首付算有效行为）→ 视为有效用户，照常发放", async () => {
    const inviter = await mkUser()
    const invitee = await mkUser()
    const { referralId } = await bindByCode({ code: await getMyCode(inviter), inviteeId: invitee })
    await backdate(referralId, RULES.abandonDays * DAY_MS + 60_000)
    await markPaidOrder(invitee) // 只付了钱、从未消费积分——延迟解锁模式下这正是触发解锁的那笔首付
    await onInviteeFirstPaid(invitee)
    const [rel] = await getDb().select().from(referrals).where(eq(referrals.id, referralId))
    expect(rel!.status).toBe("bound")
    expect(rel!.rewardState).toBe("unlocked")
    expect((await rewardRow(referralId, "inviter")).length).toBe(1)
    expect((await rewardRow(referralId, "invitee")).length).toBe(1)
  })

  it("④ 幂等：已冻结(abandoned)关系再次触发解锁 → 不发、不重复写审计", async () => {
    const inviter = await mkUser()
    const invitee = await mkUser()
    const { referralId } = await bindByCode({ code: await getMyCode(inviter), inviteeId: invitee })
    await backdate(referralId, RULES.abandonDays * DAY_MS + 60_000)
    await onInviteeFirstPaid(invitee) // 第一次：冻结 + 审计
    await onInviteeFirstPaid(invitee) // 第二次：应为安全空操作
    expect(await getBalance(inviter)).toBe(0)
    const audits = await getDb().select().from(referralRiskAudits).where(eq(referralRiskAudits.referralId, referralId))
    expect(audits.length).toBe(1) // 未重复写
  })

  it("⑤ 边界：绑定未超过 abandonDays 天 → 照常发放（不判定放弃）", async () => {
    const inviter = await mkUser()
    const invitee = await mkUser()
    const { referralId } = await bindByCode({ code: await getMyCode(inviter), inviteeId: invitee })
    await backdate(referralId, RULES.abandonDays * DAY_MS - 60_000) // 未超期 1 分钟余量
    await onInviteeFirstPaid(invitee)
    expect(await getBalance(inviter)).toBe(RULES.inviterReward)
    const [rel] = await getDb().select().from(referrals).where(eq(referrals.id, referralId))
    expect(rel!.status).toBe("bound")
    expect(rel!.rewardState).toBe("unlocked")
  })
})
