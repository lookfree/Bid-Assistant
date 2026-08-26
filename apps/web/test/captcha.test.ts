import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import {
  initCaptcha,
  CAPTCHA_TRIGGER_ID,
  CAPTCHA_TRIGGER_SEL,
  makeCaptchaVerifyHandler,
  loadAliyunCaptcha,
  __resetAliyunCaptchaCache,
  type InitAliyunCaptcha,
} from "../lib/captcha"
import { ApiError } from "../lib/api-client"

describe("makeCaptchaVerifyHandler", () => {
  it("send 成功（200）→ 返回 true，onSuccess 被调用，onError 未被调用", async () => {
    let successCalls = 0
    let errorCalls = 0
    const handler = makeCaptchaVerifyHandler(
      async () => undefined,
      () => {
        successCalls += 1
      },
      () => {
        errorCalls += 1
      },
    )
    const ok = await handler("param-1")
    expect(ok).toBe(true)
    expect(successCalls).toBe(1)
    expect(errorCalls).toBe(0)
  })

  it("send 拒绝 403（captcha_required，验签真失败）→ 返回 false，onSuccess/onError 均未被调用", async () => {
    let successCalls = 0
    let errorCalls = 0
    const handler = makeCaptchaVerifyHandler(
      async () => {
        throw new ApiError(403, "captcha_required")
      },
      () => {
        successCalls += 1
      },
      () => {
        errorCalls += 1
      },
    )
    const ok = await handler("param-1")
    expect(ok).toBe(false)
    expect(successCalls).toBe(0)
    expect(errorCalls).toBe(0)
  })

  it("send 拒绝 429（限流，拼图已通过）→ 返回 true（收起滑块），onError 被调用带上原因，onSuccess 未被调用", async () => {
    let successCalls = 0
    let errorMessage: string | undefined
    const handler = makeCaptchaVerifyHandler(
      async () => {
        throw new ApiError(429, undefined, 30)
      },
      () => {
        successCalls += 1
      },
      (message) => {
        errorMessage = message
      },
    )
    const ok = await handler("param-1")
    expect(ok).toBe(true)
    expect(successCalls).toBe(0)
    expect(errorMessage).toBeDefined()
  })

  it("send 拒绝其他错误（网络/5xx）→ 返回 true，onError 被调用，onSuccess 未被调用", async () => {
    let successCalls = 0
    let errorMessage: string | undefined
    const handler = makeCaptchaVerifyHandler(
      async () => {
        throw new Error("network error")
      },
      () => {
        successCalls += 1
      },
      (message) => {
        errorMessage = message
      },
    )
    const ok = await handler("param-1")
    expect(ok).toBe(true)
    expect(successCalls).toBe(0)
    expect(errorMessage).toBe("发送失败，请稍后重试")
  })
})

// 用最小 stub 模拟浏览器全局；bun test 无真实 DOM，手写 createElement/head/window 即可。
type FakeScript = { src: string; onload: (() => void) | null; onerror: (() => void) | null }

function installFakeDom(opts: { failLoad?: boolean } = {}) {
  let createElementCalls = 0
  const appended: FakeScript[] = []
  const fakeWindow: { initAliyunCaptcha?: InitAliyunCaptcha } = {}
  ;(globalThis as unknown as { window: unknown }).window = fakeWindow
  ;(globalThis as unknown as { document: unknown }).document = {
    createElement: (_tag: string): FakeScript => {
      createElementCalls += 1
      const el: FakeScript = { src: "", onload: null, onerror: null }
      return el
    },
    head: {
      appendChild: (el: FakeScript) => {
        appended.push(el)
        queueMicrotask(() => {
          if (opts.failLoad) {
            el.onerror?.()
            return
          }
          // 真实 SDK 脚本 onload 时已把 initAliyunCaptcha 挂到 window 上
          fakeWindow.initAliyunCaptcha = (() => {}) as unknown as InitAliyunCaptcha
          el.onload?.()
        })
      },
    },
  }
  return { getCreateElementCalls: () => createElementCalls, fakeWindow }
}

function uninstallFakeDom() {
  delete (globalThis as unknown as { window?: unknown }).window
  delete (globalThis as unknown as { document?: unknown }).document
}

describe("loadAliyunCaptcha", () => {
  beforeEach(() => {
    __resetAliyunCaptchaCache()
  })

  afterEach(() => {
    uninstallFakeDom()
  })

  it("注入脚本并在 onload 后 resolve 出 window.initAliyunCaptcha", async () => {
    const { fakeWindow } = installFakeDom()
    const initFn = await loadAliyunCaptcha()
    expect(initFn).toBe(fakeWindow.initAliyunCaptcha as InitAliyunCaptcha)
  })

  it("只注入一次：重复调用复用同一个 Promise，不新建 script", async () => {
    const { getCreateElementCalls } = installFakeDom()
    await loadAliyunCaptcha()
    await loadAliyunCaptcha()
    expect(getCreateElementCalls()).toBe(1)
  })

  it("脚本加载失败 → reject", async () => {
    installFakeDom({ failLoad: true })
    await expect(loadAliyunCaptcha()).rejects.toThrow()
  })
})

describe("initCaptcha", () => {
  it("verifyHandler 返回 true → initFn 收到的 captchaVerifyCallback 产出 { captchaResult: true }", async () => {
    let capturedCallback: ((param: string) => Promise<{ captchaResult: boolean }>) | undefined
    const initFn = ((opts: { captchaVerifyCallback: typeof capturedCallback }) => {
      capturedCallback = opts.captchaVerifyCallback
    }) as unknown as InitAliyunCaptcha

    initCaptcha({
      initFn,
      sceneId: "scene-1",
      prefix: "prefix-1",
      buttonSel: "#captcha-send-btn",
      elementSel: "#captcha-box",
      verifyHandler: async () => true,
    })

    const result = await capturedCallback!("param")
    expect(result).toEqual({ captchaResult: true })
  })

  it("verifyHandler 返回 false → captchaVerifyCallback 产出 { captchaResult: false }", async () => {
    let capturedCallback: ((param: string) => Promise<{ captchaResult: boolean }>) | undefined
    const initFn = ((opts: { captchaVerifyCallback: typeof capturedCallback }) => {
      capturedCallback = opts.captchaVerifyCallback
    }) as unknown as InitAliyunCaptcha

    initCaptcha({
      initFn,
      sceneId: "scene-1",
      prefix: "prefix-1",
      buttonSel: "#captcha-send-btn",
      elementSel: "#captcha-box",
      verifyHandler: async () => false,
    })

    const result = await capturedCallback!("param")
    expect(result).toEqual({ captchaResult: false })
  })
})


/* 2026-08-26 生产实测：什么都没填点「获取验证码」，行内提示与滑块弹窗**同时**出现。
   根因是 SDK 被绑在可见的发码按钮上——它给该元素挂自己的原生 click 监听，按钮一旦可点
   就绕过我们的校验直接弹窗。（按钮此前是真 disabled、浏览器不派发 click 才没暴露；
   为了「点灰按钮要给提示」改成 aria-disabled 之后，这条监听就活了。）
   因此绑定目标必须是隐藏触发器，弹窗只允许来自我们显式的 instance.show()。 */
describe("滑块绑定目标", () => {
  it("绑的是隐藏触发器，不是可见的发码按钮", () => {
    expect(CAPTCHA_TRIGGER_ID).toBe("captcha-trigger")
    expect(CAPTCHA_TRIGGER_SEL).toBe("#captcha-trigger")
    expect(CAPTCHA_TRIGGER_SEL).not.toBe("#captcha-send-btn")
  })

  it("initCaptcha 把 buttonSel 原样交给 SDK 的 button 参数（不会私自改绑）", () => {
    let seen: Record<string, unknown> | null = null
    initCaptcha({
      initFn: ((cfg: Record<string, unknown>) => {
        seen = cfg
      }) as never,
      sceneId: "s1",
      buttonSel: CAPTCHA_TRIGGER_SEL,
      elementSel: "#captcha-box",
      verifyHandler: async () => true,
      getInstance: () => {},
    })
    expect(seen).not.toBeNull()
    expect((seen as unknown as { button: string }).button).toBe("#captcha-trigger")
    expect((seen as unknown as { mode: string }).mode).toBe("popup")
  })
})
