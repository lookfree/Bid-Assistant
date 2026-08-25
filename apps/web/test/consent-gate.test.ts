import { describe, expect, it } from "bun:test"

import { canSendSms } from "../lib/use-sms-sender"
import { shouldRenderWxQr } from "../lib/wechat-login"

/* 协议同意必须发生在**收集个人信息之前**（2026-08-25 用户口径）。
   此前两个入口都漏了：发短信只看手机号与倒计时；微信二维码切到页签就自动出，
   用户扫码授权完了才在服务端被 terms_required 拒——同意发生在收集之后，等于没拦。 */

describe("canSendSms：发短信前必须已勾选协议", () => {
  const ok = { phone: "13900000000", countdown: 0, consented: true }

  it("手机号合法 + 无倒计时 + 已勾选 → 可发", () => {
    expect(canSendSms(ok)).toBe(true)
  })

  it("没勾选 → 不可发（哪怕手机号合法且无倒计时）", () => {
    expect(canSendSms({ ...ok, consented: false })).toBe(false)
  })

  it("原有两条限制不受影响：手机号非法 / 倒计时中一律不可发", () => {
    expect(canSendSms({ ...ok, phone: "139" })).toBe(false)
    expect(canSendSms({ ...ok, countdown: 42 })).toBe(false)
  })

  it("consented 省略 = 已同意：微信绑手机号页在扫码时就已同意过，不该再拦一次", () => {
    expect(canSendSms({ phone: "13900000000", countdown: 0 })).toBe(true)
  })
})

describe("shouldRenderWxQr：未勾选协议不出二维码", () => {
  it("在微信页签且已勾选 → 出码", () => {
    expect(shouldRenderWxQr("wechat", true)).toBe(true)
  })

  it("在微信页签但没勾选 → 不出码（不能让用户扫完授权才被拒）", () => {
    expect(shouldRenderWxQr("wechat", false)).toBe(false)
  })

  it("不在微信页签 → 不出码", () => {
    expect(shouldRenderWxQr("phone", true)).toBe(false)
  })
})
