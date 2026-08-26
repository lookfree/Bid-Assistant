"use client"

import { useEffect, useRef, useState } from "react"

import { api, captchaEnabled, captchaSceneId, captchaPrefix } from "./api"
import { loadAliyunCaptcha, makeCaptchaVerifyHandler, initCaptcha, type CaptchaInstance } from "./captcha"
import { authErrorMessage } from "./auth-errors"

export const phoneValid = (phone: string) => /^1\d{10}$/.test(phone)

/** 「获取验证码」是否可点。consented 省略=已同意——微信绑手机号页在扫码那步就已经勾过，
 *  不该再拦一次；登录页必须显式传入勾选状态（协议同意要发生在收集手机号**之前**）。 */
export function canSendSms(o: { phone: string; countdown: number; consented?: boolean }): boolean {
  return sendSmsBlockReason(o) === null
}

/** 不能发码的原因（可发时为 null）。**带 field 定位**——提示要出现在没填的那个控件旁边，
 *  顶部横幅离出错处太远（2026-08-26 用户口径）。按用户自上而下填写的顺序只报最靠前的一条，
 *  一次抛三条只会让人不知道先改哪个。
 *  按钮据此用 aria-disabled 而非 disabled：**真 disabled 的按钮浏览器不派发 click**，
 *  那样点下去毫无反应，用户只能干瞪眼。 */
export type SmsBlock = { field: "phone" | "terms" | "countdown"; message: string }

export function sendSmsBlockReason(
  o: { phone: string; countdown: number; consented?: boolean },
): SmsBlock | null {
  if (!phoneValid(o.phone)) return { field: "phone", message: "请先填写 11 位手机号" }
  if (o.consented === false) {
    return { field: "terms", message: "请先勾选并同意《用户协议》与《隐私政策》" }
  }
  if (o.countdown > 0) {
    return { field: "countdown", message: `验证码已发送，请 ${o.countdown} 秒后重试` }
  }
  return null
}

/** 「获取验证码」的完整行为：60s 倒计时 + 滑块（开启时）+ 发码。
 *
 *  抽成 hook 是因为它现在有两个入口——登录页和微信绑手机号页（2026-08-17）。
 *  两处各写一份的话，滑块那些现场踩出来的坑（show() 必须延后、fail-closed、切走要 destroy）
 *  迟早只在一处成立。挂载点固定为 #captcha-send-btn / #captcha-box，两页各自渲染这两个元素。
 */
export function useSmsSender(opts: {
  phone: string
  enabled: boolean
  onMsg: (m: string) => void
  /** 协议已勾选。省略=已同意（微信绑手机号页）；登录页必须传，否则没勾也能发短信。 */
  consented?: boolean
}) {
  const { phone, enabled, onMsg, consented } = opts
  const [countdown, setCountdown] = useState(0)
  const [captchaError, setCaptchaError] = useState(false) // SDK 加载失败 → fail-closed，禁止直接发码
  const captchaInstance = useRef<CaptchaInstance | null>(null)

  // 供滑块的 captchaVerifyCallback 读取最新手机号：SDK 在 init 时绑定一次回调，若直接闭包捕获 state
  // 会永远读到挂载时的初始值（空串）；用 ref 保证每次拖动通过时读到的是当前输入框的号码。
  const phoneRef = useRef(phone)
  useEffect(() => {
    phoneRef.current = phone
  }, [phone])

  const msgRef = useRef(onMsg)
  useEffect(() => {
    msgRef.current = onMsg
  }, [onMsg])

  useEffect(() => {
    if (countdown <= 0) return
    const timer = setTimeout(() => setCountdown(countdown - 1), 1000)
    return () => clearTimeout(timer)
  }, [countdown])

  // 初始化滑块 SDK（官方标准接法，现场逐一验证）：AliyunCaptchaConfig(region+prefix) 在脚本加载前设好
  // （loadAliyunCaptcha 内部）；挂载 init 一次、拿到实例句柄。SDK 的 button 自动绑定在本页 React/HTTP 环境下
  // 不弹窗（实测），故不靠它——由「获取验证码」onClick 调 instance.show()，且 show() 必须延后到下一个宏任务
  // （见 handleSendCode）否则同步调用不弹。表单隐藏时 destroy，重新出现（节点重建）时重新 init。
  useEffect(() => {
    if (!captchaEnabled || !enabled) return
    let cancelled = false
    const sendAfterSlide = (param: string) => {
      const currentPhone = phoneRef.current
      if (!phoneValid(currentPhone)) return Promise.reject(new Error("手机号无效"))
      return api.authApi.sendSmsCode(currentPhone, param).then(() => undefined)
    }
    loadAliyunCaptcha({ region: "cn", prefix: captchaPrefix })
      .then((initFn) => {
        if (cancelled) return
        initCaptcha({
          initFn,
          sceneId: captchaSceneId,
          buttonSel: "#captcha-send-btn",
          elementSel: "#captcha-box",
          verifyHandler: makeCaptchaVerifyHandler(
            sendAfterSlide,
            () => {
              setCountdown(60)
              msgRef.current("验证码已发送")
            },
            (m) => msgRef.current(m),
          ),
          getInstance: (inst) => {
            captchaInstance.current = inst
          },
        })
      })
      .catch(() => setCaptchaError(true))
    return () => {
      cancelled = true
      captchaInstance.current?.destroy?.()
      captchaInstance.current = null
    }
  }, [enabled])

  const canSend = canSendSms({ phone, countdown, consented })

  // 手机号为纯 11 位（+86 由后端 normalizePhone 补全）；滑块关闭时不带 captchaToken，后端 DevPass 放行。
  // 滑块开启时：手动弹出拼图（instance.show()），拖动通过后由 captchaVerifyCallback 真正发码；
  // SDK 加载失败则兜底报错，避免静默跳过验证（fail-closed）。
  async function handleSendCode() {
    if (!canSend) return          // 行内提示由调用页渲染（见 blockReason）
    onMsg("")
    if (!captchaEnabled) {
      try {
        await api.authApi.sendSmsCode(phone, undefined)
        setCountdown(60)
        onMsg("验证码已发送")
      } catch (e) {
        onMsg(authErrorMessage(e, "发送失败，请稍后重试"))
      }
      return
    }
    if (captchaError) {
      onMsg("验证组件加载失败，请刷新重试")
      return
    }
    // 弹出滑块：show() 必须延后到下一个宏任务（setTimeout 0）——同步调用不弹窗（现场实测）。
    setTimeout(() => captchaInstance.current?.show?.(), 0)
  }

  return { countdown, canSend, handleSendCode, blockReason: sendSmsBlockReason({ phone, countdown, consented }) }
}
