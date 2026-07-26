import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { Hono } from "hono"
import { publicRoutes } from "../../src/routes/public"
import { seedConfigs, setConfig } from "../../src/services/config"
import { closeDb } from "../../src/db/client"
import { TEST_TIMEOUT_MS } from "../repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/routes/public.route.test.ts）

const app = new Hono()
app.route("/api/public", publicRoutes()) // 免鉴权

beforeAll(async () => {
  await seedConfigs()
})
afterAll(async () => {
  await setConfig("signup_grant_credits", 200) // 复位默认，避免污染共享测试库
  await closeDb()
})

describe("GET /api/public/config 公开配置", () => {
  it("免鉴权返回 signupGrantCredits（读后台实时值）；只出这一个可公开值", async () => {
    await setConfig("signup_grant_credits", 777)
    const r = await app.request("/api/public/config") // 无 Authorization
    expect(r.status).toBe(200)
    const body = (await r.json()) as Record<string, number>
    expect(body.signupGrantCredits).toBe(777)
    expect(Object.keys(body)).toEqual(["signupGrantCredits"]) // 不泄漏其它配置/密钥
  })

  it("非法/负值 → 回退默认 200", async () => {
    await setConfig("signup_grant_credits", -5)
    const body = (await (await app.request("/api/public/config")).json()) as { signupGrantCredits: number }
    expect(body.signupGrantCredits).toBe(200)
  })
})
