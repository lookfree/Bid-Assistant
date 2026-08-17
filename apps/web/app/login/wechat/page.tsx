"use client"
import { Suspense, useEffect, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Phone, ArrowRight } from "lucide-react"
import { api } from "@/lib/api"
import { authErrorMessage } from "@/lib/auth-errors"
import { useSmsSender, phoneValid } from "@/lib/use-sms-sender"
import { useAuth } from "@/components/auth/auth-provider"

// 微信授权回跳页：读 code/state → 换登录。2026-08-17 起微信新号必须绑手机号——
// 后端此时不建账号、只回一次性 bindToken，本页接着要手机号+验证码，绑完才发会话。
function WechatCallbackContent() {
  const params = useSearchParams()
  const router = useRouter()
  const { login } = useAuth()
  const [msg, setMsg] = useState("正在登录…")
  const [bindToken, setBindToken] = useState("")
  const [phone, setPhone] = useState("")
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const done = useRef(false) // 只换一次：state 是一次性的，StrictMode/重渲染二次触发会撞 invalid_state

  const { countdown, canSend, handleSendCode } = useSmsSender({ phone, enabled: !!bindToken, onMsg: setMsg })

  useEffect(() => {
    if (done.current) return
    const code = params.get("code")
    const state = params.get("state")
    if (!code || !state) {
      setMsg("缺少授权参数")
      return
    }
    done.current = true
    api.authApi
      .wechatLogin(code, state)
      .then((res) => {
        if (res.needBindPhone && res.bindToken) {
          setBindToken(res.bindToken)
          setMsg("")
          return
        }
        if (!res.token || !res.user) throw new Error("登录响应异常")
        login(res.token, res.user)
        router.replace(res.isNew ? "/upload" : "/projects")
      })
      .catch((e) => setMsg(authErrorMessage(e, "微信登录失败，请重试")))
  }, [params, router, login])

  async function submitBind(e: React.FormEvent) {
    e.preventDefault()
    if (busy || !phoneValid(phone) || code.length !== 6) return
    setBusy(true)
    setMsg("")
    try {
      const res = await api.authApi.wechatBindPhone(bindToken, phone, code)
      login(res.token, res.user)
      router.replace(res.isNew ? "/upload" : "/projects")
    } catch (e) {
      setMsg(authErrorMessage(e, "绑定失败，请重试"))
      setBusy(false) // 成功时不复位：页面正在跳走，复位只会让按钮闪一下变回可点
    }
  }

  if (!bindToken) return <div className="p-8 text-center text-muted-foreground">{msg}</div>

  return (
    <main className="flex min-h-screen items-start justify-center bg-secondary/40 px-6 py-16">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-7 shadow-sm sm:p-8">
        <h1 className="text-xl font-bold tracking-tight text-foreground">绑定手机号</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          微信授权已完成。绑定手机号后即可登录；若该手机号已注册，将直接登录原账号。
        </p>
        {msg && (
          <div className="mt-5 rounded-xl border border-border bg-muted/50 p-3.5">
            <p className="text-sm leading-relaxed text-foreground">{msg}</p>
          </div>
        )}
        <form onSubmit={submitBind} className="mt-6 flex flex-col gap-4">
          <div className="flex items-center rounded-lg border border-input bg-background focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
            <span className="flex items-center gap-1.5 border-r border-input px-3 text-sm text-muted-foreground">
              <Phone className="size-4" />
              +86
            </span>
            <input
              type="tel"
              inputMode="numeric"
              maxLength={11}
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
              placeholder="请输入手机号"
              className="w-full bg-transparent px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="flex gap-2">
            <input
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
              disabled={!canSend}
              className="shrink-0 rounded-lg border border-input bg-background px-4 text-sm font-medium text-primary transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:text-muted-foreground"
            >
              {countdown > 0 ? `${countdown}s 后重发` : "获取验证码"}
            </button>
          </div>
          {/* 阿里云验证码2.0 弹层容器：滑块关闭时始终为空 */}
          <div id="captcha-box" />
          <button
            type="submit"
            disabled={busy || !phoneValid(phone) || code.length !== 6}
            className="mt-2 inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "绑定中…" : "绑定并登录"}
            <ArrowRight className="size-4" />
          </button>
        </form>
      </div>
    </main>
  )
}

export default function WechatCallbackPage() {
  return (
    <Suspense fallback={null}>
      <WechatCallbackContent />
    </Suspense>
  )
}
