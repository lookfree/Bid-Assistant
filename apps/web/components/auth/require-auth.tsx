"use client"
import { useEffect, type ReactNode } from "react"
import { useRouter, usePathname } from "next/navigation"
import { useAuth } from "./auth-provider"

// 未登录跳 /login 并带上当前路径，登录后可回到原页；登录态还原中（loading）先不渲染，避免闪烁受保护内容。
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth()
  const router = useRouter()
  const pathname = usePathname()
  useEffect(() => {
    if (!loading && !user) router.replace(`/login?redirect=${encodeURIComponent(pathname)}`)
  }, [loading, user, router, pathname])
  if (loading || !user) return null
  return <>{children}</>
}
