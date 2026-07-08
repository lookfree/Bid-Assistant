"use client"
import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import { api, setAuthExpiredHandler } from "@/lib/api"
import { ApiError } from "@/lib/api-client"
import { tokenStore } from "@/lib/token-store"

type User = { id: string; nickname: string | null; status?: string }
type AuthCtx = {
  user: User | null
  loading: boolean
  login: (token: string, user: User) => void
  logout: () => Promise<void>
  refresh: () => Promise<void>
}

const Ctx = createContext<AuthCtx | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  // 启动/刷新时用本地令牌向 /auth/me 还原当前用户。
  // 只有 401（令牌真的失效/撤销）才清令牌；网络抖动/瞬时 5xx 重试两次——
  // 否则一次闪断就把登录态吹掉，用户回退个页面就被迫重新登录。
  async function refresh() {
    if (!tokenStore.get()) {
      setUser(null)
      setLoading(false)
      return
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        setUser(await api.authApi.me())
        setLoading(false)
        return
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          tokenStore.clear()
          setUser(null)
          setLoading(false)
          return
        }
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1500))
      }
    }
    // 连续失败（服务暂不可用）：保留令牌，仅本次未能还原——守卫会引导去登录页，令牌恢复后仍可用
    setUser(null)
    setLoading(false)
  }
  useEffect(() => {
    void refresh()
  }, [])

  // 后台请求 401（令牌过期/撤销）时立即复位登录态，交由守卫跳登录，不必等下次刷新。
  useEffect(() => {
    setAuthExpiredHandler(() => setUser(null))
    return () => setAuthExpiredHandler(null)
  }, [])

  const login = (token: string, u: User) => {
    tokenStore.set(token)
    setUser(u)
  }
  const logout = async () => {
    try {
      await api.authApi.logout()
    } finally {
      tokenStore.clear()
      setUser(null)
    }
  }

  return <Ctx.Provider value={{ user, loading, login, logout, refresh }}>{children}</Ctx.Provider>
}

export function useAuth() {
  const v = useContext(Ctx)
  if (!v) throw new Error("useAuth 必须在 <AuthProvider> 内使用")
  return v
}
