// 阿里云验证码2.0（滑块拼图）前端集成：惰性加载官方 SDK 脚本 + 校验回调封装。
// SDK 具体字段以官方文档为准；此处按官方通用契约实现（下方类型对齐官方 initAliyunCaptcha 入参形态）。

const SCRIPT_SRC = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"

export type CaptchaVerifyCallbackResult = {
  captchaResult: boolean
  bizResult?: boolean
}

export type InitAliyunCaptchaOptions = {
  SceneId: string
  prefix: string
  mode: "popup"
  button: string
  element: string
  captchaVerifyCallback: (param: string) => Promise<CaptchaVerifyCallbackResult>
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

// 纯逻辑，安全核心：用户拖动通过后 SDK 调此回调 → 真正发码；发码成功才算验证通过（true=收起滑块，false=让用户重滑）。
export function makeCaptchaVerifyHandler(
  send: (param: string) => Promise<void>,
  onSuccess: () => void,
): (param: string) => Promise<boolean> {
  return async (param: string) => {
    try {
      await send(param)
      onSuccess()
      return true
    } catch {
      return false
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
  })
}
