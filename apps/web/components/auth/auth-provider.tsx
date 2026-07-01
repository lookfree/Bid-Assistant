"use client"
import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import { api } from "@/lib/api"
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

  // 启动/刷新时用本地令牌向 /auth/me 还原当前用户；令牌失效则清掉。
  async function refresh() {
    if (!tokenStore.get()) {
      setUser(null)
      setLoading(false)
      return
    }
    try {
      setUser(await api.authApi.me())
    } catch {
      tokenStore.clear()
      setUser(null)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void refresh()
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
