"use client"
import { useEffect, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "./auth-provider"

// 未登录跳 /login；登录态还原中（loading）先不渲染，避免闪烁受保护内容。
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth()
  const router = useRouter()
  useEffect(() => {
    if (!loading && !user) router.replace("/login")
  }, [loading, user, router])
  if (loading) return null
  if (!user) return null
  return <>{children}</>
}
