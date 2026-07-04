import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { getDb, closeDb } from "../src/db/client"
import { users } from "../src/db/schema"
import { getMyCode, resolveInviter, bindByCode } from "../src/services/referral"
import { DuplicateInviteeError, InvalidCodeError, SelfReferralError } from "../src/services/referral-errors"
import { seedConfigs } from "../src/services/config"
import { makeLedgerUser, TEST_TIMEOUT_MS, expectConflict } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/referral-code.test.ts）

const madeUsers: string[] = []
const mkUser = () => makeLedgerUser((id) => madeUsers.push(id))

beforeAll(async () => {
  await seedConfigs()
})
afterAll(async () => {
  for (const id of madeUsers) await getDb().delete(users).where(eq(users.id, id)) // referral_codes/referrals 级联删
  await closeDb()
})

describe("spec307 邀请码（每用户唯一一个，幂等）", () => {
  it("getMyCode 幂等：同用户两次同码；code→inviter 可解析", async () => {
    const u = await mkUser()
    const c1 = await getMyCode(u)
    const c2 = await getMyCode(u)
    expect(c1).toBe(c2)
    expect(c1.length).toBe(6)
    expect(await resolveInviter(c1)).toBe(u)
  })

  it("码全局唯一（不同用户不同码）；无效码解析为 undefined", async () => {
    const a = await mkUser()
    const b = await mkUser()
    expect(await getMyCode(a)).not.toBe(await getMyCode(b))
    expect(await resolveInviter("ZZZZZZ")).toBeUndefined()
  })
})

describe("spec307 绑定关系（invitee 唯一 / 自荐拦截 / 无效码）", () => {
  it("正常绑定建 referrals；自荐拦截；无效码拦截", async () => {
    const inviter = await mkUser()
    const invitee = await mkUser()
    const code = await getMyCode(inviter)

    await expect(bindByCode({ code, inviteeId: inviter })).rejects.toBeInstanceOf(SelfReferralError)
    await expect(bindByCode({ code: "ZZZZZZ", inviteeId: invitee })).rejects.toBeInstanceOf(InvalidCodeError)

    const r = await bindByCode({ code, inviteeId: invitee })
    expect(r.referralId).toBeTruthy()
    expect(r.frozen).toBe(false)
  })

  it("同一被邀请人二次绑定 → DuplicateInviteeError（invitee 唯一约束兜底）", async () => {
    const invitee = await mkUser()
    const i1 = await mkUser()
    const i2 = await mkUser()
    await bindByCode({ code: await getMyCode(i1), inviteeId: invitee })
    await expect(bindByCode({ code: await getMyCode(i2), inviteeId: invitee })).rejects.toBeInstanceOf(DuplicateInviteeError)
  })

  it("DB 唯一约束实证：不能给同一 invitee 直插两条 referrals", async () => {
    const { referrals } = await import("../src/db/schema")
    const inviter = await mkUser()
    const invitee = await mkUser()
    await getDb().insert(referrals).values({ inviterId: inviter, inviteeId: invitee, code: "X", status: "bound" })
    await expectConflict(() =>
      getDb().insert(referrals).values({ inviterId: inviter, inviteeId: invitee, code: "Y", status: "bound" }),
    )
  })
})
