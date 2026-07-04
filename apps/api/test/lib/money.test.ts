import { describe, it, expect } from "bun:test"
import { centsToYuan, yuanToCents } from "../../src/lib/money"

describe("spec308 金额换算", () => {
  it("分→元", () => {
    expect(centsToYuan(3900)).toBe(39)
    expect(centsToYuan(159900)).toBe(1599)
    expect(centsToYuan(1)).toBe(0.01)
    expect(centsToYuan(0)).toBe(0)
  })

  it("元→分（四舍五入到整数分）", () => {
    expect(yuanToCents(39)).toBe(3900)
    expect(yuanToCents(0.1)).toBe(10)
    expect(yuanToCents(0)).toBe(0)
    expect(yuanToCents(15.99)).toBe(1599)
  })

  it("往返一致", () => {
    expect(yuanToCents(centsToYuan(12345))).toBe(12345)
  })
})
