import { describe, expect, it } from "bun:test"

import { canSendSms, sendSmsBlockReason } from "../lib/use-sms-sender"
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


/* 灰按钮点下去要说清为什么，而且**提示要出现在没填的那个地方**（2026-08-26 用户口径）——
   顶部横幅离出错处太远。故原因带 field 定位，页面据此在对应控件下方渲染。
   注意：真 disabled 的按钮浏览器不派发 click，按钮因此改为 aria-disabled + 可点击。 */
describe("sendSmsBlockReason：说清为什么不能发，并指出是哪一处", () => {
  it("可发时没有原因", () => {
    expect(sendSmsBlockReason({ phone: "13900000000", countdown: 0, consented: true })).toBeNull()
  })

  it("手机号没填/不完整 → 定位到手机号", () => {
    expect(sendSmsBlockReason({ phone: "", countdown: 0, consented: true }))
      .toEqual({ field: "phone", message: "请先填写 11 位手机号" })
    expect(sendSmsBlockReason({ phone: "139", countdown: 0, consented: true })?.field).toBe("phone")
  })

  it("没勾协议 → 定位到协议勾选框", () => {
    expect(sendSmsBlockReason({ phone: "13900000000", countdown: 0, consented: false }))
      .toEqual({ field: "terms", message: "请先勾选并同意《用户协议》与《隐私政策》" })
  })

  it("倒计时中 → 定位到按钮自身（按钮上已显示读秒，页面不再重复渲染行内提示）", () => {
    expect(sendSmsBlockReason({ phone: "13900000000", countdown: 42, consented: true }))
      .toEqual({ field: "countdown", message: "验证码已发送，请 42 秒后重试" })
  })

  it("手机号与协议都缺 → 先指手机号（用户自上而下填，一次只点亮最靠前的那处）", () => {
    expect(sendSmsBlockReason({ phone: "", countdown: 0, consented: false })?.field).toBe("phone")
  })
})
