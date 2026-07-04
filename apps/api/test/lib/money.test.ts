import { describe, it, expect } from "bun:test"
import { centsToYuan } from "../../src/lib/money"

describe("spec308 金额换算", () => {
  it("分→元", () => {
    expect(centsToYuan(3900)).toBe(39)
    expect(centsToYuan(159900)).toBe(1599)
    expect(centsToYuan(1)).toBe(0.01)
    expect(centsToYuan(0)).toBe(0)
  })
})
