import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import {
  makeCaptchaVerifyHandler,
  loadAliyunCaptcha,
  initCaptcha,
  __resetAliyunCaptchaCache,
  type InitAliyunCaptcha,
} from "../lib/captcha"

describe("makeCaptchaVerifyHandler", () => {
  it("send 成功 → 返回 true 且 onSuccess 被调用一次", async () => {
    let calls = 0
    const handler = makeCaptchaVerifyHandler(
      async () => undefined,
      () => {
        calls += 1
      },
    )
    const ok = await handler("param-1")
    expect(ok).toBe(true)
    expect(calls).toBe(1)
  })

  it("send 失败（后端 403/网络错）→ 返回 false 且 onSuccess 未被调用", async () => {
    let calls = 0
    const handler = makeCaptchaVerifyHandler(
      async () => {
        throw new Error("captcha_required")
      },
      () => {
        calls += 1
      },
    )
    const ok = await handler("param-1")
    expect(ok).toBe(false)
    expect(calls).toBe(0)
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
