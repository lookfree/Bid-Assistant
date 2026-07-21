// 阿里云验证码2.0（滑块拼图）前端集成：惰性加载官方 SDK 脚本 + 校验回调封装。
// SDK 具体字段以官方文档为准；此处按官方通用契约实现（下方类型对齐官方 initAliyunCaptcha 入参形态）。

import { ApiError } from "./api-client"
import { authErrorMessage } from "./auth-errors"

const SCRIPT_SRC = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"

export type CaptchaVerifyCallbackResult = {
  captchaResult: boolean
  bizResult?: boolean
}

// SDK 实例句柄（由 getInstance 回调交付）：show 手动弹出滑块（本页不依赖 SDK 的 button 自动绑定——
// 实测该绑定在 React 环境下不触发，改由发码按钮 onClick 调 show()）；destroy 用于 tab 切走时收尾。
export type CaptchaInstance = {
  show?: () => void
  destroy?: () => void
}

export type InitAliyunCaptchaOptions = {
  SceneId: string
  prefix: string
  mode: "popup"
  button: string
  element: string
  captchaVerifyCallback: (param: string) => Promise<CaptchaVerifyCallbackResult>
  getInstance?: (instance: CaptchaInstance) => void
}

export type InitAliyunCaptcha = (opts: InitAliyunCaptchaOptions) => void

declare global {
  interface Window {
    initAliyunCaptcha?: InitAliyunCaptcha
  }
}

// 模块级缓存：SDK 脚本只注入一次；重复调用复用同一个 Promise。
let loadPromise: Promise<InitAliyunCaptcha> | null = null

// 惰性注入官方 CDN 脚本，resolve 出全局暴露的 initAliyunCaptcha。SSR 下无 window，直接 reject。
export function loadAliyunCaptcha(): Promise<InitAliyunCaptcha> {
  if (typeof window === "undefined") return Promise.reject(new Error("SSR: window 不可用"))
  if (loadPromise) return loadPromise
  if (window.initAliyunCaptcha) {
    loadPromise = Promise.resolve(window.initAliyunCaptcha)
    return loadPromise
  }
  loadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script")
    script.src = SCRIPT_SRC
    script.onload = () => {
      if (window.initAliyunCaptcha) resolve(window.initAliyunCaptcha)
      else reject(new Error("AliyunCaptcha.js 加载后未暴露 initAliyunCaptcha"))
    }
    script.onerror = () => reject(new Error("AliyunCaptcha.js 加载失败"))
    document.head.appendChild(script)
  })
  return loadPromise
}

// 仅供测试重置模块级缓存，生产代码不调用。
export function __resetAliyunCaptchaCache(): void {
  loadPromise = null
}

// 纯逻辑，安全核心：用户拖动通过后 SDK 调此回调 → 真正发码。
// 后端顺序是「验签 → 限流」：拼图本身校验通过后仍可能因限流/5xx/网络错被拒——此时不能告诉 SDK
// captchaResult:false（会逼用户重滑，但重滑对限流无济于事，且掩盖了真实原因）。只有 403(captcha_required，
// 验签本身没过) 才是拼图真的失败，需要重滑；其余一律视为「拼图已通过」（收起滑块），把原因交给 onError 展示。
export function makeCaptchaVerifyHandler(
  send: (param: string) => Promise<void>,
  onSuccess: () => void,
  onError: (message: string) => void,
): (param: string) => Promise<boolean> {
  return async (param: string) => {
    try {
      await send(param)
      onSuccess()
      return true
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) return false
      onError(authErrorMessage(e, "发送失败，请稍后重试"))
      return true
    }
  }
}

export type InitCaptchaOptions = {
  initFn: InitAliyunCaptcha
  sceneId: string
  prefix: string
  buttonSel: string
  elementSel: string
  verifyHandler: (param: string) => Promise<boolean>
  // 可选：拿到 SDK 实例句柄，供调用方在 tab 切走时 destroy 掉，避免重新 init 时和上一个实例并存/重复绑定。
  getInstance?: (instance: CaptchaInstance) => void
}

// 薄封装：把 verifyHandler 的 boolean 结果包成 SDK 要求的 { captchaResult } 形状。
export function initCaptcha(opts: InitCaptchaOptions): void {
  opts.initFn({
    SceneId: opts.sceneId,
    prefix: opts.prefix,
    mode: "popup",
    button: opts.buttonSel,
    element: opts.elementSel,
    captchaVerifyCallback: async (param) => ({ captchaResult: await opts.verifyHandler(param) }),
    getInstance: opts.getInstance,
  })
}
