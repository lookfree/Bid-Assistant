import { describe, it, expect, afterAll, setDefaultTimeout } from "bun:test"
import { preDeduct, settle, STEP_COST } from "../src/services/billing-stub"
import { closeDb } from "../src/db/client"
import { TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // settle 连真库

afterAll(async () => {
  await closeDb()
})

describe("billing-stub", () => {
  it("preDeduct(read) 放行并返回该步额度", async () => {
    const r = await preDeduct("read")
    expect(r).toEqual({ ok: true, hold: STEP_COST.read! })
    expect(r.hold).toBe(10)
  })

  it("preDeduct 覆盖六步档位（content 最贵）", async () => {
    expect((await preDeduct("content")).hold).toBe(30)
    expect((await preDeduct("export")).hold).toBe(2)
  })

  it("preDeduct 未知步骤 hold=0", async () => {
    expect(await preDeduct("nope")).toEqual({ ok: true, hold: 0 })
  })

  it("settle 汇总该 run 用量并按 hold 结算（消费路径打通）", async () => {
    // 无用量行的 run（合法 uuid）：sum=0，stub 按 hold 结算
    const cost = await settle(crypto.randomUUID(), 10)
    expect(cost).toBe(10)
  })
})
