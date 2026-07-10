"use client"

import type React from "react"

import { useState, useEffect, useRef, Suspense } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Phone, ShieldCheck, Sparkles, ArrowRight, FileSearch, PenLine, Download, QrCode } from "lucide-react"
import { api, captchaEnabled, captchaSceneId, captchaPrefix } from "@/lib/api"
import { loadAliyunCaptcha, makeCaptchaVerifyHandler, initCaptcha } from "@/lib/captcha"
import { authErrorMessage } from "@/lib/auth-errors"
import { renderWxLogin } from "@/lib/wechat-login"
import { useAuth } from "@/components/auth/auth-provider"

const benefits = [
  { icon: FileSearch, text: "免费解析招标文件" },
  { icon: PenLine, text: "AI 生成目录与正文" },
  { icon: Download, text: "一键导出投标文件" },
]

function LoginContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const redirect = searchParams.get("redirect") || "/upload"
  const reason = searchParams.get("reason")
  const referralCode = searchParams.get("ref") || undefined // 邀请链接 /login?ref=CODE：首次注册带上 → 绑定推荐关系

  const { login } = useAuth()
  const [tab, setTab] = useState<"phone" | "wechat">("phone")
  const [phone, setPhone] = useState("")
  const [code, setCode] = useState("")
  const [countdown, setCountdown] = useState(0)
  const [agreed, setAgreed] = useState(false)
  const [msg, setMsg] = useState("")
  const [busy, setBusy] = useState(false)
  const [captchaReady, setCaptchaReady] = useState(false) // 滑块 SDK 是否已加载并绑定完成
  const [captchaError, setCaptchaError] = useState(false) // SDK 加载失败 → fail-closed，禁止直接发码

  // 供滑块的 captchaVerifyCallback 读取最新手机号：SDK 在 init 时绑定一次回调，若直接闭包捕获 state
  // 会永远读到挂载时的初始值（空串）；用 ref 保证每次拖动通过时读到的是当前输入框的号码。
  const phoneRef = useRef(phone)
  useEffect(() => {
    phoneRef.current = phone
  }, [phone])

  useEffect(() => {
    if (countdown <= 0) return
    const timer = setTimeout(() => setCountdown(countdown - 1), 1000)
    return () => clearTimeout(timer)
  }, [countdown])

  const phoneValid = /^1\d{10}$/.test(phone)
  const canSend = phoneValid && countdown === 0
  const canSubmit = phoneValid && code.length === 6 && agreed

  // 滑块开启时：加载阿里云验证码2.0 SDK 并把「获取验证码」按钮接管为弹窗触发器；拖动通过后才真正发码。
  useEffect(() => {
    if (!captchaEnabled) return
    let cancelled = false
    const sendAfterSlide = (param: string) => {
      const currentPhone = phoneRef.current
      if (!/^1\d{10}$/.test(currentPhone)) return Promise.reject(new Error("手机号无效"))
      return api.authApi.sendSmsCode(currentPhone, param).then(() => undefined)
    }
    const onSlideSuccess = () => {
      setCountdown(60)
      setMsg("验证码已发送")
    }
    loadAliyunCaptcha()
      .then((initFn) => {
        if (cancelled) return
        initCaptcha({
          initFn,
          sceneId: captchaSceneId,
          prefix: captchaPrefix,
          buttonSel: "#captcha-send-btn",
          elementSel: "#captcha-box",
          verifyHandler: makeCaptchaVerifyHandler(sendAfterSlide, onSlideSuccess),
        })
        setCaptchaReady(true)
      })
      .catch(() => setCaptchaError(true))
    return () => {
      cancelled = true
    }
  }, [])

  // 手机号为纯 11 位（+86 由后端 normalizePhone 补全）；滑块关闭时不带 captchaToken，后端 DevPass 放行。
  // 滑块开启时按钮已被 SDK 接管弹出拼图，这里不再直接发码（交给 captchaVerifyCallback）；
  // 仅在 SDK 加载失败时兜底报错，避免静默跳过验证（fail-closed）。
  async function handleSendCode() {
    if (!canSend) return
    setMsg("")
    if (!captchaEnabled) {
      try {
        await api.authApi.sendSmsCode(phone, undefined)
        setCountdown(60)
        setMsg("验证码已发送")
      } catch (e) {
        setMsg(authErrorMessage(e, "发送失败，请稍后重试"))
      }
      return
    }
    if (captchaError) setMsg("验证组件加载失败，请刷新重试")
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit || busy) return
    setBusy(true)
    setMsg("")
    try {
      const { token, user } = await api.authApi.verifySmsCode(phone, code, agreed, referralCode)
      login(token, user)
      router.push(redirect)
    } catch (e) {
      setMsg(authErrorMessage(e, "登录失败，请稍后重试"))
    } finally {
      setBusy(false)
    }
  }

  // 微信登录：先建 state（含协议同意位）→ 有真实 appId 则渲染官方二维码；开发期无凭据给出提示。
  async function handleWechatQr() {
    if (!agreed) {
      setMsg("请先同意《用户协议》和《隐私政策》")
      return
    }
    setMsg("")
    try {
      const { state, appId, scope, redirectUri } = await api.authApi.wechatAuthUrl(agreed)
      if (!appId) {
        setMsg("开发期未配置微信凭据，二维码暂不可用（真实凭据就绪后自动生效）")
        return
      }
      await renderWxLogin({ id: "wx-qr", appid: appId, scope, redirect_uri: encodeURIComponent(redirectUri), state })
    } catch (e) {
      setMsg(authErrorMessage(e, "生成二维码失败，请重试"))
    }
  }

  const switchTab = (t: "phone" | "wechat") => {
    setTab(t)
    setMsg("")
  }

  return (
    <div className="flex min-h-screen flex-col bg-secondary/40">
      {/* 顶部品牌 */}
      <header className="flex items-center justify-center px-6 pt-10 sm:pt-14">
        <Link href="/" className="flex items-center gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-xl gradient-brand">
            <Sparkles className="size-5 text-white" />
          </div>
          <span className="text-base font-semibold text-foreground">智启元 · 投标助手</span>
        </Link>
      </header>

      {/* 居中卡片 */}
      <main className="flex flex-1 items-start justify-center px-6 py-8 sm:py-10">
        <div className="w-full max-w-sm">
          <div className="rounded-2xl border border-border bg-card p-7 shadow-sm sm:p-8">
            {reason && (
              <div className="mb-6 flex items-start gap-2.5 rounded-xl border border-primary/20 bg-primary/5 p-3.5">
                <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
                <p className="text-sm leading-relaxed text-foreground">{reason}</p>
              </div>
            )}

            {msg && (
              <div className="mb-6 rounded-xl border border-border bg-muted/50 p-3.5">
                <p className="text-sm leading-relaxed text-foreground">{msg}</p>
              </div>
            )}

            <h1 className="text-2xl font-bold tracking-tight text-foreground">登录 / 注册</h1>
            <p className="mt-2 text-sm text-muted-foreground">未注册的手机号将自动创建账号</p>

            {/* 登录方式切换 */}
            <div className="mt-6 flex gap-1 rounded-lg bg-secondary/60 p-1">
              <button
                type="button"
                onClick={() => switchTab("phone")}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${tab === "phone" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              >
                <Phone className="size-4" />
                手机号登录
              </button>
              <button
                type="button"
                onClick={() => switchTab("wechat")}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${tab === "wechat" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              >
                <QrCode className="size-4" />
                微信登录
              </button>
            </div>

            {tab === "phone" ? (
            <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
              <div>
                <label htmlFor="phone" className="mb-1.5 block text-sm font-medium text-foreground">
                  手机号
                </label>
                <div className="flex items-center rounded-lg border border-input bg-background focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
                  <span className="flex items-center gap-1.5 border-r border-input px-3 text-sm text-muted-foreground">
                    <Phone className="size-4" />
                    +86
                  </span>
                  <input
                    id="phone"
                    type="tel"
                    inputMode="numeric"
                    maxLength={11}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
                    placeholder="请输入手机号"
                    className="w-full bg-transparent px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="code" className="mb-1.5 block text-sm font-medium text-foreground">
                  验证码
                </label>
                <div className="flex gap-2">
                  <input
                    id="code"
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                    placeholder="6 位验证码"
                    className="w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/20"
                  />
                  <button
                    id="captcha-send-btn"
                    type="button"
                    onClick={handleSendCode}
                    disabled={!canSend || (captchaEnabled && !captchaReady && !captchaError)}
                    className="shrink-0 rounded-lg border border-input bg-background px-4 text-sm font-medium text-primary transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:text-muted-foreground"
                  >
                    {countdown > 0 ? `${countdown}s 后重发` : "获取验证码"}
                  </button>
                </div>
                {/* 阿里云验证码2.0 弹层容器：滑块关闭时始终为空，不渲染任何东西 */}
                <div id="captcha-box" />
              </div>

              <button
                type="submit"
                disabled={!canSubmit || busy}
                className="mt-2 inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "登录中…" : "登录 / 注册"}
                <ArrowRight className="size-4" />
              </button>
            </form>
            ) : (
              <div className="mt-6 flex flex-col items-center gap-4">
                <div
                  id="wx-qr"
                  className="flex min-h-[208px] w-full items-center justify-center rounded-lg border border-dashed border-input bg-background"
                >
                  <span className="px-6 text-center text-sm text-muted-foreground">
                    点击下方按钮生成微信登录二维码
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleWechatQr}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  <QrCode className="size-4" />
                  生成二维码
                </button>
                <p className="text-xs text-muted-foreground">微信扫码授权后将自动登录 / 注册</p>
              </div>
            )}

            {/* 协议同意（手机号 / 微信 两种方式共用） */}
            <label className="mt-4 flex cursor-pointer items-start gap-2 text-xs leading-relaxed text-muted-foreground">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                className="mt-0.5 size-3.5 shrink-0 rounded border-input accent-primary"
              />
              <span>
                我已阅读并同意
                <a href="#" className="text-primary hover:underline">
                  《用户协议》
                </a>
                与
                <a href="#" className="text-primary hover:underline">
                  《隐私政策》
                </a>
              </span>
            </label>
          </div>

          {/* 价值点 */}
          <ul className="mt-6 flex items-center justify-center gap-5">
            {benefits.map((b) => (
              <li key={b.text} className="flex flex-col items-center gap-1.5 text-center">
                <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <b.icon className="size-4.5" />
                </span>
                <span className="max-w-[6.5rem] text-xs leading-tight text-muted-foreground">{b.text}</span>
              </li>
            ))}
          </ul>

          <div className="mt-6 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5 text-success" />
            数据全程加密，仅你本人可见
          </div>
        </div>
      </main>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginContent />
    </Suspense>
  )
}
