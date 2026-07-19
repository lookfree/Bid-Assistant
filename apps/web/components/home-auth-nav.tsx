"use client"

import Link from "next/link"
import { useAuth } from "@/components/auth/auth-provider"

/** 首页顶栏右侧（登录态感知）：未登录=登录+免费试用;已登录=直接进入工作台——
 *  首页是服务端组件,登录态收在这个客户端小组件里（与工具页 HeaderAuth 同法）。 */
export function HomeAuthNav() {
  const { user, loading } = useAuth()

  if (loading) return <div className="h-9 w-28" />

  if (user) {
    return (
      <div className="flex items-center gap-2">
        <span className="hidden text-sm text-muted-foreground sm:inline">{user.nickname ?? "已登录"}</span>
        <Link
          href="/projects"
          className="rounded-lg gradient-brand px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
        >
          进入工作台
        </Link>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <Link
        href="/login"
        className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        登录
      </Link>
      <Link
        href="/login"
        className="rounded-lg gradient-brand px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
      >
        免费试用
      </Link>
    </div>
  )
}
