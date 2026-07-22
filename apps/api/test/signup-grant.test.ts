import { describe, it, expect, beforeEach, afterAll, setDefaultTimeout } from "bun:test"
import { inArray, eq } from "drizzle-orm"
import { getDb, closeDb } from "../src/db/client"
import { users, creditTransactions } from "../src/db/schema"
import { loginWithPhone } from "../src/services/auth"
import { getBalance } from "../src/services/credits"
import { seedConfigs, setConfig } from "../src/services/config"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/signup-grant.test.ts）

const made: string[] = []
const reg = (id: string) => made.push(id)
const login = (phone: string) => loginWithPhone(phone, { agreedToTerms: true }, 30, async () => true)

beforeEach(async () => {
  await seedConfigs()
  await setConfig("signup_grant_credits", 200) // 每例还原种子默认（个别例会改）
})
afterAll(async () => {
  await setConfig("signup_grant_credits", 200)
  await setConfig("grant_expire_days", 0) // 还原种子默认（0=不过期）
  if (made.length) await getDb().delete(users).where(inArray(users.id, made))
  await closeDb()
})

describe("首次注册赠送积分（配置驱动，幂等）", () => {
  it("新用户注册到账 = signup_grant_credits 配置值", async () => {
    const { user, isNew } = await login(uniquePhone())
    reg(user.id)
    expect(isNew).toBe(true)
    expect(await getBalance(user.id)).toBe(200)
  })

  it("额度走配置不写死：改成 500 则到账 500", async () => {
    await setConfig("signup_grant_credits", 500)
    const { user } = await login(uniquePhone())
    reg(user.id)
    expect(await getBalance(user.id)).toBe(500)
  })

  it("幂等：同号二次登录（非新注册）不重复赠送", async () => {
    const phone = uniquePhone()
    const first = await login(phone)
    reg(first.user.id)
    expect(await getBalance(first.user.id)).toBe(200)
    const second = await login(phone)
    expect(second.isNew).toBe(false)
    expect(await getBalance(first.user.id)).toBe(200) // 未翻倍
  })

  it("grant_expire_days=0：注册赠送不设过期时间（不过期）", async () => {
    await setConfig("grant_expire_days", 0)
    const { user } = await login(uniquePhone())
    reg(user.id)
    const [tx] = await getDb().select().from(creditTransactions).where(eq(creditTransactions.idempotencyKey, `signup_grant:${user.id}`))
    expect(tx!.expireAt).toBeNull()
  })

  it("grant_expire_days=30：注册赠送带过期时间", async () => {
    await setConfig("grant_expire_days", 30)
    const { user } = await login(uniquePhone())
    reg(user.id)
    const [tx] = await getDb().select().from(creditTransactions).where(eq(creditTransactions.idempotencyKey, `signup_grant:${user.id}`))
    expect(tx!.expireAt).not.toBeNull()
  })

  it("配置为 0：不赠送，但注册照常成功", async () => {
    await setConfig("signup_grant_credits", 0)
    const { user, isNew } = await login(uniquePhone())
    reg(user.id)
    expect(isNew).toBe(true)
    expect(await getBalance(user.id)).toBe(0)
  })
})
