import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import {
  makeCaptchaVerifyHandler,
  loadAliyunCaptcha,
  initCaptcha,
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
