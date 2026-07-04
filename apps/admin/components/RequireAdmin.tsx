"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { adminApi } from "@/lib/admin-api"
import { adminTokenStore } from "@/lib/admin-token-store"

// 登录守卫（spec309）：无有效 admin 会话 → 跳 /login。功能页在 (admin) 布局内包裹本组件。
export function RequireAdmin({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let alive = true
    if (!adminTokenStore.get()) {
      router.replace("/login")
      return
    }
    adminApi
      .me()
      .then(() => alive && setReady(true))
      .catch(() => {
        adminTokenStore.clear()
        router.replace("/login")
      })
    return () => {
      alive = false
    }
  }, [router])

  if (!ready) return <div className="p-8 text-sm text-muted-foreground">校验登录态…</div>
  return <>{children}</>
}
