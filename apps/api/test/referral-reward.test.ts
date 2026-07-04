import { describe, it, expect, beforeEach, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { getDb, closeDb } from "../src/db/client"
import { users, billingConfigs, referrals, creditTransactions } from "../src/db/schema"
import { getMyCode, bindByCode, onInviteeFirstPaid } from "../src/services/referral"
import { getBalance } from "../src/services/credits"
import { getConfig, seedConfigs, setConfig } from "../src/services/config"
import { makeLedgerUser, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/referral-reward.test.ts）

const madeUsers: string[] = []
const mkUser = () => makeLedgerUser((id) => madeUsers.push(id))
const SEED_RULES = { inviterReward: 50, inviteeReward: 50, unlockOn: "invitee_first_paid", capPerUser: 500, riskMaxPerIpPerHour: 20 }

beforeEach(async () => {
  await seedConfigs()
  await setConfig("referral_rules", SEED_RULES) // 每例还原种子（各例可能改配置）
})
afterAll(async () => {
  await setConfig("referral_rules", SEED_RULES)
  for (const id of madeUsers) await getDb().delete(users).where(eq(users.id, id))
  await closeDb()
})

const rewardRow = (referralId: string, role: string) =>
  getDb().select().from(creditTransactions).where(eq(creditTransactions.idempotencyKey, `referral:${referralId}:${role}`))

describe("spec307 两段发放 + 双方额度（断言=配置值，不写死魔数）", () => {
  it("延迟解锁：首次付费后双方各得配置额度，落 referral_reward 流水带有效期", async () => {
    const rules = (await getConfig<typeof SEED_RULES>("referral_rules"))!
    const inviter = await mkUser()
    const invitee = await mkUser()
    const code = await getMyCode(inviter)

    const { rewarded, referralId } = await bindByCode({ code, inviteeId: invitee })
    expect(rewarded).toBe(false) // 延迟解锁，绑定不发
    expect(await getBalance(inviter)).toBe(0)

    await onInviteeFirstPaid(invitee)
    expect(await getBalance(inviter)).toBe(rules.inviterReward)
    expect(await getBalance(invitee)).toBe(rules.inviteeReward)
    const [inviterTx] = await rewardRow(referralId, "inviter")
    expect(inviterTx!.type).toBe("referral_reward")
    expect(inviterTx!.expireAt).not.toBeNull() // reward_expire_days 有效期
    expect((await getDb().select().from(referrals).where(eq(referrals.id, referralId)))[0]!.rewardState).toBe("unlocked")
  })

  it("立即发放：unlockOn 为空时绑定即发双方配置额度", async () => {
    await setConfig("referral_rules", { inviterReward: 20, inviteeReward: 30, unlockOn: "", capPerUser: 1000, riskMaxPerIpPerHour: 20 })
    const inviter = await mkUser()
    const invitee = await mkUser()
    const { rewarded } = await bindByCode({ code: await getMyCode(inviter), inviteeId: invitee })
    expect(rewarded).toBe(true)
    expect(await getBalance(inviter)).toBe(20)
    expect(await getBalance(invitee)).toBe(30)
  })

  it("幂等：重复触发 onInviteeFirstPaid 不重发", async () => {
    const rules = (await getConfig<typeof SEED_RULES>("referral_rules"))!
    const inviter = await mkUser()
    const invitee = await mkUser()
    await bindByCode({ code: await getMyCode(inviter), inviteeId: invitee })
    await onInviteeFirstPaid(invitee)
    await onInviteeFirstPaid(invitee) // 二次
    expect(await getBalance(inviter)).toBe(rules.inviterReward) // 仍一份
  })

  it("封顶：累计达 capPerUser → 本条 capped 不发，不误伤已 unlocked 旧关系", async () => {
    await setConfig("referral_rules", { inviterReward: 400, inviteeReward: 0, unlockOn: "invitee_first_paid", capPerUser: 500, riskMaxPerIpPerHour: 20 })
    const inviter = await mkUser()
    const i1 = await mkUser()
    const i2 = await mkUser()
    const r1 = await bindByCode({ code: await getMyCode(inviter), inviteeId: i1 })
    const r2 = await bindByCode({ code: await getMyCode(inviter), inviteeId: i2 })
    await onInviteeFirstPaid(i1) // +400 → 400，r1 unlocked
    await onInviteeFirstPaid(i2) // 400+400>500 → r2 capped，不发
    expect(await getBalance(inviter)).toBe(400)
    expect((await getDb().select().from(referrals).where(eq(referrals.id, r1.referralId)))[0]!.rewardState).toBe("unlocked")
    expect((await getDb().select().from(referrals).where(eq(referrals.id, r2.referralId)))[0]!.rewardState).toBe("capped")
  })

  it("onInviteeFirstPaid：非被邀请人 / 无 pending 关系 → 安全空操作", async () => {
    const stranger = await mkUser()
    await onInviteeFirstPaid(stranger)
    expect(await getBalance(stranger)).toBe(0)
  })

  it("配置 unlockOn 为空（立即发）时，钩子不重复发", async () => {
    await setConfig("referral_rules", { inviterReward: 10, inviteeReward: 10, unlockOn: "", capPerUser: 1000, riskMaxPerIpPerHour: 20 })
    const inviter = await mkUser()
    const invitee = await mkUser()
    await bindByCode({ code: await getMyCode(inviter), inviteeId: invitee }) // 立即发 10/10
    await onInviteeFirstPaid(invitee) // unlockOn != invitee_first_paid → 直接返回
    expect(await getBalance(invitee)).toBe(10)
  })
})
