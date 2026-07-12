"use client"
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"
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
  // 还原在途标记：focus/online 与首挂载可能并发触发 refresh——退避循环长达 ~30s，期间叠加的
  // 循环会打请求风暴，且迟到的失败循环最后的 setUser(null) 会把已恢复的登录态清掉（后写覆盖先写）。
  const refreshing = useRef(false)

  // 启动/刷新时用本地令牌向 /auth/me 还原当前用户。
  // 只有 401（令牌真的失效/撤销）才清令牌；非 401 失败按退避重试、总共扛 ~30s——
  // 服务发版重启 api 有 10~30s 不可用窗口，此前只重试 ~3s，撞上就把有效登录态误判成"要重新登录"。
  const RETRY_DELAYS_MS = [1500, 3000, 6000, 9000, 12000]
  async function refresh() {
    if (refreshing.current) return   // 已有一次在途还原：并发触发一律忽略，由它收尾
    refreshing.current = true
    try {
      if (!tokenStore.get()) {
        setUser(null)
        setLoading(false)
        return
      }
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
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
          const delay = RETRY_DELAYS_MS[attempt]
          if (delay !== undefined) await new Promise((r) => setTimeout(r, delay))
        }
      }
      // 连续失败（服务长时间不可用）：保留令牌，仅本次未能还原——守卫会引导去登录页，令牌恢复后仍可用
      setUser(null)
      setLoading(false)
    } finally {
      refreshing.current = false
    }
  }
  useEffect(() => {
    void refresh()
  }, [])

  // 兜底自动接回：上面放弃后（user=null 但令牌还在=服务当时不可用），窗口重获焦点/网络恢复时
  // 自动再还原一次——服务恢复后用户切回页面即自动登录，不必手动重登。
  useEffect(() => {
    const retry = () => {
      if (!user && !loading && tokenStore.get()) void refresh()
    }
    window.addEventListener("focus", retry)
    window.addEventListener("online", retry)
    return () => {
      window.removeEventListener("focus", retry)
      window.removeEventListener("online", retry)
    }
  }, [user, loading])

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
