import { describe, it, expect } from "bun:test"
import { AdminApiError } from "../lib/admin-api"

/* 生产实测（2026-07-31）：后台退款失败只显示「admin api 422」，而服务端其实回了
   「扣回积分 100 超过当前余额 9（用户已消费）：需操作员确认后携 allowNegativeBalance 重试」。
   唯一有用的信息被吞掉，运营对着 422 无从下手，同一订单连退 4 次都失败。 */

describe("AdminApiError：服务端给的原因不能被吞掉", () => {
  it("有 code 时 message 用服务端原因，而不是「admin api 4xx」", () => {
    const why = "扣回积分 100 超过当前余额 9（用户已消费）：需操作员确认后携 allowNegativeBalance 重试"
    const e = new AdminApiError(422, why)
    expect(e.message).toBe(why)
    expect(e.code).toBe(why)     // code 仍保留，按错误码分支的调用方不受影响
    expect(e.status).toBe(422)
  })

  it("服务端没给原因时回落到状态码，不至于是空串", () => {
    const e = new AdminApiError(500)
    expect(e.message).toBe("admin api 500")
  })

  it("401 等靠 status 分支的调用方不受影响", () => {
    const e = new AdminApiError(401, "unauthorized")
    expect(e.status).toBe(401)
    expect(e.message).toBe("unauthorized")
  })
})
