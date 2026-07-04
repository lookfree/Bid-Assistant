"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { adminApi, AdminApiError } from "@/lib/admin-api"
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
      .catch((e) => {
        if (!alive) return
        // 仅 401（会话失效）才登出跳转；瞬时错误（5xx/网络）保留登录态、乐观放行，由各页自行处理错误。
        if (e instanceof AdminApiError && e.status === 401) {
          adminTokenStore.clear()
          router.replace("/login")
        } else {
          setReady(true)
        }
      })
    return () => {
      alive = false
    }
  }, [router])

  if (!ready) return <div className="p-8 text-sm text-muted-foreground">校验登录态…</div>
  return <>{children}</>
}
