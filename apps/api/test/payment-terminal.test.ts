import { describe, it, expect, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { getDb, closeDb } from "../src/db/client"
import { paymentTerminals } from "../src/db/schema"
import { md5BodySign } from "../src/services/payment/shouqianba-sign"
import { makeTerminalService, type SqbTerminalConfig } from "../src/services/payment/terminal"
import { TEST_TIMEOUT_MS } from "./repos/helpers"
import { fakeGateway } from "./helpers/sqb-gateway"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/payment-terminal.test.ts）

// mock 网关：不打真实收钱吧。终端凭证生命周期 = 激活（vendor 签名）→ 落库（key 加密）→ 每日签到（terminal 签名）轮换 key。

const deviceId = `dev-test-${Date.now()}` // 远程共享 DB：device_id 唯一防撞
const cfg: SqbTerminalConfig = {
  gateway: "https://sqb.test",
  vendorSn: "VSN1",
  vendorKey: "VKEY1",
  appId: "APP1",
  activationCode: "CODE1",
  deviceId,
  keySecret: "unit-test-secret",
}

const activateOk = {
  result_code: "200",
  biz_response: { terminal_sn: `TSN-${deviceId}`, terminal_key: "plain-terminal-key-v1" },
}

afterAll(async () => {
  await getDb().delete(paymentTerminals).where(eq(paymentTerminals.deviceId, deviceId))
  await closeDb()
})

describe("spec304 终端服务（激活/签到）", () => {
  it("activate：vendor 签名请求 → terminal_key 加密落库（库里不存明文）", async () => {
    const { calls, fetchFn } = fakeGateway([activateOk])
    const svc = makeTerminalService(cfg, fetchFn)
    const sn = await svc.activate()
    expect(sn).toBe(`TSN-${deviceId}`)

    // 请求形态：激活用 vendor 参数签名，body 含 app_id/code/device_id
    const req = calls[0]!
    expect(req.url).toContain("https://sqb.test")
    const body = JSON.parse(req.body)
    expect(body.app_id).toBe("APP1")
    expect(body.code).toBe("CODE1")
    expect(body.device_id).toBe(deviceId)
    expect(req.auth).toBe(`VSN1 ${md5BodySign(req.body, "VKEY1")}`)

    // 落库：加密存储，明文 key 不落库
    const [row] = await getDb().select().from(paymentTerminals).where(eq(paymentTerminals.deviceId, deviceId))
    expect(row).toBeDefined()
    expect(row!.terminalSn).toBe(`TSN-${deviceId}`)
    expect(row!.terminalKey).not.toBe("plain-terminal-key-v1")
    expect(row!.terminalKey).not.toContain("plain-terminal-key")

    // 解密可还原（provider 用）
    const cred = await svc.getCredentials()
    expect(cred).toEqual({ terminalSn: `TSN-${deviceId}`, terminalKey: "plain-terminal-key-v1" })
  })

  it("checkin：terminal 签名（用当前 key）→ 轮换新 key + last_checkin_at", async () => {
    const checkinOk = { result_code: "200", biz_response: { terminal_sn: `TSN-${deviceId}`, terminal_key: "rotated-key-v2" } }
    const { calls, fetchFn } = fakeGateway([checkinOk])
    const svc = makeTerminalService(cfg, fetchFn)
    await svc.checkin()

    // 签到用 terminal_sn + 当前（激活时的）terminal_key 签名
    const req = calls[0]!
    expect(req.auth).toBe(`TSN-${deviceId} ${md5BodySign(req.body, "plain-terminal-key-v1")}`)
    expect(JSON.parse(req.body).terminal_sn).toBe(`TSN-${deviceId}`)

    const [row] = await getDb().select().from(paymentTerminals).where(eq(paymentTerminals.deviceId, deviceId))
    expect(row!.lastCheckinAt).not.toBeNull()
    const cred = await svc.getCredentials()
    expect(cred.terminalKey).toBe("rotated-key-v2") // key 已轮换且解密可用
  })

  it("checkin 失败：保留旧 key 不写坏（网关错误/网络异常都不得改库）", async () => {
    const before = await currentRow()
    // 网关业务失败
    const svc1 = makeTerminalService(cfg, fakeGateway([{ result_code: "400", error_message: "签到失败" }]).fetchFn)
    await expect(svc1.checkin()).rejects.toThrow()
    // 网络异常
    const svc2 = makeTerminalService(cfg, fakeGateway([new Error("ECONNRESET")]).fetchFn)
    await expect(svc2.checkin()).rejects.toThrow()

    const after = await currentRow()
    expect(after.terminalKey).toBe(before.terminalKey) // 旧密文原样
    expect(String(after.lastCheckinAt)).toBe(String(before.lastCheckinAt))
    const cred = await makeTerminalService(cfg, fakeGateway([]).fetchFn).getCredentials()
    expect(cred.terminalKey).toBe("rotated-key-v2") // 仍是上次成功轮换的 key
  })

  it("未激活时 getCredentials/checkin 报可读错误（不静默）", async () => {
    const fresh = { ...cfg, deviceId: `dev-none-${Date.now()}` }
    const svc = makeTerminalService(fresh, fakeGateway([]).fetchFn)
    await expect(svc.getCredentials()).rejects.toThrow(/未激活/)
    await expect(svc.checkin()).rejects.toThrow(/未激活/)
  })
})

async function currentRow() {
  const [row] = await getDb().select().from(paymentTerminals).where(eq(paymentTerminals.deviceId, deviceId))
  if (!row) throw new Error("终端行不存在")
  return row
}
