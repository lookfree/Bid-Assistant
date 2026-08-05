import { describe, it, expect } from "bun:test"
import { orderStatusCn, orderTypeCn, yuan } from "../../src/lib/order-labels"

describe("订单枚举中文化", () => {
  it("状态全部有中文", () => {
    expect(["created", "paid", "failed", "unknown", "refunded"].map(orderStatusCn)).toEqual([
      "待支付",
      "已支付",
      "支付失败",
      "支付结果待核对",
      "已退款",
    ])
  })

  it("类型全部有中文，且会员单不叫「自动续费」——本产品不做代扣", () => {
    expect(orderTypeCn("recharge")).toBe("积分充值")
    expect(orderTypeCn("purchase")).toBe("单笔购买")
    expect(orderTypeCn("renewal")).toBe("会员开通/续费")
    expect(orderTypeCn("renewal")).not.toContain("自动")
  })

  it("库外取值原样回显，不吞成「未知」——真出问题时运营要能报出原文", () => {
    expect(orderStatusCn("weird")).toBe("weird")
    expect(orderTypeCn("weird")).toBe("weird")
  })
})

describe("金额分→元", () => {
  it.each([
    [3900, "¥39.00"],
    [1, "¥0.01"],
    [0, "¥0.00"],
    [123456, "¥1234.56"],
  ])("%i 分 → %s", (cents, expected) => {
    expect(yuan(cents)).toBe(expected)
  })
})
