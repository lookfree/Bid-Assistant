"use client"

import { useEffect, useRef, useState } from "react"
import { copyText } from "@/lib/clipboard"
import { api } from "@/lib/api"
import { Gift, Copy, Check, Users, Coins } from "lucide-react"

// 邀请好友独立页（把原会员页角落的小卡片提为一级入口，方便发现与使用）。
export default function ReferralPage() {
  const [code, setCode] = useState<string | null>(null)
  const [count, setCount] = useState<number | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle")
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const inviteLink = code ? `${typeof window !== "undefined" ? window.location.origin : ""}/login?ref=${code}` : ""

  async function copy(text: string) {
    const ok = await copyText(text)
    setCopyState(ok ? "copied" : "failed")
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopyState("idle"), 2000)
  }
  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current)
  }, [])

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const c = await api.request<{ code: string }>("/api/referral/code")
        const l = await api.request<{ list: unknown[] }>("/api/referral/list")
        if (!alive) return
        setCode(c.code)
        setCount(l.list.length)
      } catch {
        if (alive) setLoadFailed(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:py-10">
      <div className="flex items-center gap-3">
        <span className="flex size-11 items-center justify-center rounded-xl gradient-brand-soft text-primary">
          <Gift className="size-6" />
        </span>
        <div>
          <h1 className="text-xl font-semibold text-foreground">邀请好友</h1>
          <p className="text-sm text-muted-foreground">好友通过你的链接注册，双方都得积分奖励</p>
        </div>
      </div>

      {loadFailed ? (
        <p className="mt-8 rounded-2xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
          邀请信息加载失败，刷新页面重试。
        </p>
      ) : (
        <div className="mt-6 rounded-2xl border border-primary/15 gradient-brand-soft p-6">
          <p className="text-xs text-muted-foreground">我的专属邀请码</p>
          <p className="mt-1 font-mono text-3xl font-bold tracking-widest text-primary">{code ?? "······"}</p>

          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
            <input
              readOnly
              value={inviteLink}
              className="min-w-0 flex-1 truncate rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-muted-foreground"
            />
            <button
              type="button"
              disabled={!code}
              onClick={() => copy(inviteLink)}
              className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {copyState === "copied" ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制邀请链接"}
            </button>
          </div>

          <div className="mt-4 flex items-center gap-2 text-sm text-foreground">
            <Users className="size-4 text-primary" />
            已成功邀请 <span className="font-semibold">{count ?? 0}</span> 位好友
          </div>
        </div>
      )}

      <div className="mt-6 rounded-2xl border border-border bg-card p-6">
        <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Coins className="size-4 text-primary" />
          怎么获得奖励
        </p>
        <ol className="mt-3 flex flex-col gap-2.5 text-sm text-muted-foreground">
          <li>1. 复制上方邀请链接，分享给好友（微信、QQ 均可）。</li>
          <li>2. 好友通过链接注册成为新用户。</li>
          <li>3. 好友注册成功后，你和好友都将各获得一次积分奖励。</li>
        </ol>
      </div>
    </div>
  )
}
