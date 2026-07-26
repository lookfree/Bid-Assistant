import { describe, it, expect } from "bun:test"
import { CONFIG_SCHEMAS } from "../../src/routes/admin/plans"

const schema = () => CONFIG_SCHEMAS["credit_cost.content_tiers"]! // noUncheckedIndexedAccess：键已知存在

describe("管理端阶梯写入校验", () => {
  it("合法阶梯放行", () => {
    expect(schema().safeParse([{ maxChars: 50_000, cost: 40 }, { maxChars: null, cost: 260 }]).success).toBe(true)
  })
  it("空数组 / 非数组拒绝", () => {
    expect(schema().safeParse([]).success).toBe(false)
    expect(schema().safeParse({}).success).toBe(false)
  })
  it("没有顶档 / 多个顶档拒绝", () => {
    expect(schema().safeParse([{ maxChars: 50_000, cost: 40 }]).success).toBe(false)
    expect(schema().safeParse([{ maxChars: null, cost: 40 }, { maxChars: null, cost: 80 }]).success).toBe(false)
  })
  it("字数上限重复拒绝", () => {
    expect(
      schema().safeParse([{ maxChars: 5_000, cost: 40 }, { maxChars: 5_000, cost: 80 }, { maxChars: null, cost: 90 }])
        .success,
    ).toBe(false)
  })
  it("非法数值拒绝（0/负/小数上限、负价、小数价）", () => {
    expect(schema().safeParse([{ maxChars: 0, cost: 40 }, { maxChars: null, cost: 80 }]).success).toBe(false)
    expect(schema().safeParse([{ maxChars: 1.5, cost: 40 }, { maxChars: null, cost: 80 }]).success).toBe(false)
    expect(schema().safeParse([{ maxChars: null, cost: -1 }]).success).toBe(false)
    expect(schema().safeParse([{ maxChars: null, cost: 1.5 }]).success).toBe(false)
  })
  it("未知键拒绝（防运营拼错字段名静默失效）", () => {
    expect(schema().safeParse([{ maxChars: null, cost: 40, price: 9 }]).success).toBe(false)
  })
})
