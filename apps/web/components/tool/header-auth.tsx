"use client"

import Link from "next/link"
import { LogIn, LogOut, User } from "lucide-react"
import { useAuth } from "@/components/auth/auth-provider"

/** 顶栏右侧登录态区：已登录显示昵称+退出，未登录显示登录入口（layout 是服务端组件，登录态感知收在这个客户端小组件里）。 */
export function HeaderAuth() {
  const { user, loading, logout } = useAuth()

  if (loading) return <div className="size-9" />

  if (!user) {
    return (
      <div className="flex items-center gap-2">
        <Link
          href="/login"
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <LogIn className="size-4" />
          <span className="hidden sm:inline">立即登录</span>
        </Link>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <Link
        href="/membership"
        className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
        aria-label="个人中心"
      >
        <span className="flex size-7 items-center justify-center rounded-full bg-secondary">
          <User className="size-4" />
        </span>
        <span className="hidden max-w-28 truncate sm:inline">{user.nickname || "我的账户"}</span>
      </Link>
      <button
        type="button"
        onClick={() => void logout()}
        className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        aria-label="退出登录"
      >
        <LogOut className="size-4" />
        <span className="hidden sm:inline">退出</span>
      </button>
    </div>
  )
}
