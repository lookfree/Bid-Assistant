"use client"

import type React from "react"

import { useState, useEffect, Suspense } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Phone, ShieldCheck, Sparkles, ArrowRight, FileSearch, PenLine, Download, QrCode } from "lucide-react"
import { api } from "@/lib/api"
import { useSmsSender, phoneValid, type SmsBlock } from "@/lib/use-sms-sender"
import { authErrorMessage } from "@/lib/auth-errors"
import { renderWxLogin, shouldRenderWxQr } from "@/lib/wechat-login"
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
  const [agreed, setAgreed] = useState(false)
  const [msg, setMsg] = useState("")
  const [busy, setBusy] = useState(false)

  // 发码（倒计时 + 滑块）与微信绑手机号页共用同一份实现，见 lib/use-sms-sender.ts
  const { countdown, canSend, handleSendCode, blockReason } = useSmsSender({
    phone, enabled: tab === "phone", onMsg: setMsg, consented: agreed,
  })
  // 点了灰按钮才点亮行内提示（未点过就红字满屏是另一种糟糕）；用户一改动对应项立即消失。
  const [blocked, setBlocked] = useState<SmsBlock | null>(null)
  function trySendCode() {
    setBlocked(blockReason)
    if (!blockReason) void handleSendCode()
  }
  const canSubmit = phoneValid(phone) && code.length === 6 && agreed

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

  // 微信登录：切到页签即自动出码，无需再点按钮（用户反馈）。**但必须先勾选协议**
  // （2026-08-25）——不勾就出码的话，用户一路扫码授权完，才在服务端被 terms_required 拒，
  // 同意发生在收集之后等于没拦。勾选状态一变就重建 state 并重渲染二维码。
  useEffect(() => {
    if (!shouldRenderWxQr(tab, agreed)) return
    let alive = true
    ;(async () => {
      try {
        const { state, appId, scope, redirectUri } = await api.authApi.wechatAuthUrl(agreed)
        if (!alive) return // 页签已切走/勾选又变了：别用旧 state 盖掉新二维码
        if (!appId) {
          setMsg("微信登录暂未配置，请用手机号登录")
          return
        }
        await renderWxLogin({ id: "wx-qr", appid: appId, scope, redirect_uri: encodeURIComponent(redirectUri), state })
      } catch (e) {
        if (alive) setMsg(authErrorMessage(e, "二维码加载失败，请刷新重试"))
      }
    })()
    return () => {
      alive = false
    }
  }, [tab, agreed])

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
                    onChange={(e) => {
                      setPhone(e.target.value.replace(/\D/g, ""))
                      setBlocked((b) => (b?.field === "phone" ? null : b))
                    }}
                    placeholder="请输入手机号"
                    className="w-full bg-transparent px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
                  />
                </div>
                {blocked?.field === "phone" && (
                  <p className="mt-1.5 text-xs text-destructive">{blocked.message}</p>
                )}
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
                    onClick={trySendCode}
                    aria-disabled={!canSend}
                    className="shrink-0 rounded-lg border border-input bg-background px-4 text-sm font-medium text-primary transition-colors hover:bg-muted aria-disabled:cursor-not-allowed aria-disabled:text-muted-foreground aria-disabled:hover:bg-background"
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
                {/* 取消勾选要**卸载整个容器**，不能只是不再渲染：WxLogin 把二维码 iframe 注进
                    #wx-qr，effect 提前返回不会清掉它——旧码留在页面上照样能扫。换成条件渲染，
                    React 卸载该节点时连注入的 iframe 一起带走。 */}
                {agreed ? (
                  <div
                    id="wx-qr"
                    className="flex min-h-[208px] w-full items-center justify-center rounded-lg border border-dashed border-input bg-background"
                  >
                    <span className="px-6 text-center text-sm text-muted-foreground">二维码加载中…</span>
                  </div>
                ) : (
                  <div className="flex min-h-[208px] w-full items-center justify-center rounded-lg border border-dashed border-input bg-background">
                    <span className="px-6 text-center text-sm text-muted-foreground">
                      请先勾选下方《用户协议》与《隐私政策》，勾选后自动显示二维码
                    </span>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  微信扫码授权后需绑定手机号；该手机号已注册的，将直接登录原账号
                </p>
              </div>
            )}

            {/* 协议同意（手机号 / 微信 两种方式共用） */}
            <label className="mt-4 flex cursor-pointer items-start gap-2 text-xs leading-relaxed text-muted-foreground">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => {
                  setAgreed(e.target.checked)
                  setBlocked((b) => (b?.field === "terms" ? null : b))
                }}
                className="mt-0.5 size-3.5 shrink-0 rounded border-input accent-primary"
              />
              <span>
                我已阅读并同意
                <a href="/terms" target="_blank" className="text-primary hover:underline">
                  《用户协议》
                </a>
                与
                <a href="/privacy" target="_blank" className="text-primary hover:underline">
                  《隐私政策》
                </a>
              </span>
            </label>
            {blocked?.field === "terms" && (
              <p className="mt-1.5 pl-5.5 text-xs text-destructive">{blocked.message}</p>
            )}
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
