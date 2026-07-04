import { describe, it, expect, beforeEach, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { createApp } from "../src/app"
import type { SmsCodeService } from "../src/services/sms-code"
import { loginWithPhone } from "../src/services/auth"
import { getMyCode, bindByCode, sweepPendingReferralUnlocks, onInviteeFirstPaid } from "../src/services/referral"
import { markPaid } from "../src/services/payment-orders"
import { getBalance } from "../src/services/credits"
import { seedConfigs, setConfig } from "../src/services/config"
import { getDb, closeDb } from "../src/db/client"
import { users, referrals } from "../src/db/schema"
import { findUserByIdentity } from "../src/repos/users"
import { makeLedgerUser, makeTestOrder, uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/referral-wiring.test.ts）

const DELAYED = { inviterReward: 50, inviteeReward: 50, unlockOn: "invitee_first_paid", capPerUser: 500, riskMaxPerIpPerHour: 20 }
const madeUsers: string[] = []
const madePhones: string[] = []
const reg = (id: string) => madeUsers.push(id)
const fakeSms: SmsCodeService = { async request() { return { ok: true } }, async verify(_p, code) { return code === "123456" } }

beforeEach(async () => {
  await seedConfigs()
  await setConfig("referral_rules", DELAYED)
})
afterAll(async () => {
  for (const id of madeUsers) await getDb().delete(users).where(eq(users.id, id))
  for (const p of madePhones) {
    const u = await findUserByIdentity("phone", p)
    if (u) await getDb().delete(users).where(eq(users.id, u.id))
  }
  await setConfig("referral_rules", DELAYED)
  await closeDb()
})

describe("spec307 R1-R6 接线", () => {
  it("R1 注册接线：首次注册带邀请码 → 建 bound 关系（inviter/invitee/deviceHash 正确）", async () => {
    const inviter = await makeLedgerUser(reg)
    const code = await getMyCode(inviter)
    const phone = uniquePhone()
    madePhones.push(phone)
    const { isNew, user } = await loginWithPhone(phone, { agreedToTerms: true, referralCode: code, deviceHash: "dev-r1", ip: "1.2.3.4" }, 30, async () => true)
    expect(isNew).toBe(true)
    const [rel] = await getDb().select().from(referrals).where(eq(referrals.inviteeId, user.id))
    expect(rel!.inviterId).toBe(inviter)
    expect(rel!.status).toBe("bound")
    expect(rel!.deviceHash).toBe("dev-r1")
  })

  it("R1 坏邀请码不阻断注册（自荐/无效码吞错）", async () => {
    const phone = uniquePhone()
    madePhones.push(phone)
    const { isNew } = await loginWithPhone(phone, { agreedToTerms: true, referralCode: "ZZZZZZ", ip: "1.1.1.1" }, 30, async () => true)
    expect(isNew).toBe(true) // 注册成功，无关系
    const u = await findUserByIdentity("phone", phone)
    expect((await getDb().select().from(referrals).where(eq(referrals.inviteeId, u!.id))).length).toBe(0)
  })

  it("R2 服务端派生指纹：经 /auth/sms/verify 注册带码 → deviceHash 非空（客户端未传也有）", async () => {
    const app = createApp({ pingDb: async () => true, smsCode: fakeSms })
    const inviter = await makeLedgerUser(reg)
    const code = await getMyCode(inviter)
    const phone = uniquePhone()
    madePhones.push(phone)
    const res = await app.request("/auth/sms/verify", {
      method: "POST",
      headers: { "content-type": "application/json", "User-Agent": "TestUA/1.0" },
      body: JSON.stringify({ phone, code: "123456", agreedToTerms: true, referralCode: code }),
    })
    expect(res.status).toBe(200)
    const u = await findUserByIdentity("phone", phone)
    const [rel] = await getDb().select().from(referrals).where(eq(referrals.inviteeId, u!.id))
    expect(rel!.inviterId).toBe(inviter)
    expect(typeof rel!.deviceHash).toBe("string")
    expect(rel!.deviceHash!.length).toBeGreaterThan(10) // sha256 hex，服务端派生
  })

  it("R5 端到端：bind 延迟解锁 → 充值单 markPaid → 钩子解锁双方发奖", async () => {
    const inviter = await makeLedgerUser(reg)
    const invitee = await makeLedgerUser(reg)
    await bindByCode({ code: await getMyCode(inviter), inviteeId: invitee })
    const order = await makeTestOrder(invitee, "created", 1000, { type: "recharge", creditsSnapshot: 100 })
    const res = await markPaid(order.id, { paidAmountCents: 1000 })
    expect(res.paid).toBe(true)
    expect((await getDb().select().from(referrals).where(eq(referrals.inviteeId, invitee)))[0]!.rewardState).toBe("unlocked")
    expect(await getBalance(inviter)).toBe(50)
  })

  it("R3 重扫兜底：bound+pending 且被邀请人已 paid 单 → sweep 重驱解锁", async () => {
    const inviter = await makeLedgerUser(reg)
    const invitee = await makeLedgerUser(reg)
    await bindByCode({ code: await getMyCode(inviter), inviteeId: invitee })
    // 模拟钩子瞬时失败：直接建一张 paid 单但不经 markPaid 钩子（关系停在 pending）
    await makeTestOrder(invitee, "paid", 1000, { type: "recharge" })
    expect((await getDb().select().from(referrals).where(eq(referrals.inviteeId, invitee)))[0]!.rewardState).toBe("pending")
    const n = await sweepPendingReferralUnlocks()
    expect(n).toBeGreaterThanOrEqual(1)
    expect((await getDb().select().from(referrals).where(eq(referrals.inviteeId, invitee)))[0]!.rewardState).toBe("unlocked")
  })

  it("R6 状态建模：邀请人封顶 + 被邀请人正常发 → rewardState=unlocked（不被 capped 覆盖）", async () => {
    await setConfig("referral_rules", { inviterReward: 400, inviteeReward: 50, unlockOn: "invitee_first_paid", capPerUser: 500, riskMaxPerIpPerHour: 20 })
    const inviter = await makeLedgerUser(reg)
    const i1 = await makeLedgerUser(reg)
    const i2 = await makeLedgerUser(reg)
    await bindByCode({ code: await getMyCode(inviter), inviteeId: i1 })
    await bindByCode({ code: await getMyCode(inviter), inviteeId: i2 })
    await onInviteeFirstPaid(i1) // inviter +400 → 400
    await onInviteeFirstPaid(i2) // inviter 400+400>500 封顶，但 i2 被邀请人 +50 发出 → unlocked（非 capped）
    const [r2] = await getDb().select().from(referrals).where(eq(referrals.inviteeId, i2))
    expect(r2!.rewardState).toBe("unlocked")
    expect(await getBalance(i2)).toBe(50) // 被邀请人拿到 50
    expect(await getBalance(inviter)).toBe(400) // 邀请人封在 400
  })
})
