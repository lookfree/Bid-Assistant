import { describe, it, expect, beforeEach, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { getDb, closeDb } from "../src/db/client"
import { users, referrals, referralRiskAudits } from "../src/db/schema"
import { getMyCode, bindByCode, onInviteeFirstPaid } from "../src/services/referral"
import { getBalance } from "../src/services/credits"
import { seedConfigs, setConfig } from "../src/services/config"
import { createTestUser, makeLedgerUser, uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/referral-risk.test.ts）

const madeUsers: string[] = []
const mkUser = () => makeLedgerUser((id) => madeUsers.push(id))
const RULES = { inviterReward: 50, inviteeReward: 50, unlockOn: "invitee_first_paid", capPerUser: 500, riskMaxPerIpPerHour: 3 }

beforeEach(async () => {
  await seedConfigs()
  await setConfig("referral_rules", RULES) // riskMaxPerIpPerHour=3 便于测同 IP 集中
})
afterAll(async () => {
  await setConfig("referral_rules", { ...RULES, riskMaxPerIpPerHour: 20 })
  for (const id of madeUsers) await getDb().delete(users).where(eq(users.id, id))
  await closeDb()
})

describe("spec307 防刷风控（冻结 + 审计留痕；冻结关系不发奖）", () => {
  it("设备查重：同 deviceHash 二次邀请 → status=frozen + frozenReason + 审计", async () => {
    const inviter = await mkUser()
    const code = await getMyCode(inviter)
    const dev = `dev-${Date.now()}`
    await bindByCode({ code, inviteeId: await mkUser(), deviceHash: dev })
    const r2 = await bindByCode({ code, inviteeId: await mkUser(), deviceHash: dev })
    expect(r2.frozen).toBe(true)
    const [rec] = await getDb().select().from(referrals).where(eq(referrals.id, r2.referralId))
    expect(rec!.status).toBe("frozen")
    expect(rec!.frozenReason).toBe("duplicate_device")
    const audits = await getDb().select().from(referralRiskAudits).where(eq(referralRiskAudits.referralId, r2.referralId))
    expect(audits.length).toBeGreaterThan(0)
    expect(audits[0]!.reason).toBe("duplicate_device")
  })

  it("同 IP 集中时段：达阈值后冻结（reason=same_ip_burst）", async () => {
    const inviter = await mkUser()
    const code = await getMyCode(inviter)
    const ip = `10.0.0.${Date.now() % 250}`
    // 阈值 3：前 3 单不冻，第 4 单冻
    for (let i = 0; i < 3; i++) expect((await bindByCode({ code, inviteeId: await mkUser(), ip })).frozen).toBe(false)
    const r4 = await bindByCode({ code, inviteeId: await mkUser(), ip })
    expect(r4.frozen).toBe(true)
    expect((await getDb().select().from(referrals).where(eq(referrals.id, r4.referralId)))[0]!.frozenReason).toBe("same_ip_burst")
  })

  it("手机号查重：同手机号换账号再被邀请 → 冻结（reason=duplicate_phone）", async () => {
    const phone = uniquePhone()
    const inviter1 = await mkUser()
    const first = await createTestUser(phone) // 有手机身份的被邀请人
    madeUsers.push(first.id)
    await bindByCode({ code: await getMyCode(inviter1), inviteeId: first.id, phone })

    const inviter2 = await mkUser()
    const second = await mkUser() // 另一账号，声称同手机号
    const r = await bindByCode({ code: await getMyCode(inviter2), inviteeId: second, phone })
    expect(r.frozen).toBe(true)
    expect((await getDb().select().from(referrals).where(eq(referrals.id, r.referralId)))[0]!.frozenReason).toBe("duplicate_phone")
  })

  it("冻结关系：首次付费也不发奖（onInviteeFirstPaid 守卫 status=bound）", async () => {
    const inviter = await mkUser()
    const code = await getMyCode(inviter)
    const dev = `dup-${Date.now()}`
    await bindByCode({ code, inviteeId: await mkUser(), deviceHash: dev })
    const victim = await mkUser()
    await bindByCode({ code, inviteeId: victim, deviceHash: dev }) // victim 冻结
    await onInviteeFirstPaid(victim)
    expect(await getBalance(inviter)).toBe(0) // 冻结关系不发
  })
})
