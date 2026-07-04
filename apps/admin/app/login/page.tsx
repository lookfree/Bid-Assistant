"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { adminApi } from "@/lib/admin-api"
import { adminTokenStore } from "@/lib/admin-token-store"

// 运营后台登录（spec309）：账号 + 密码 → adminApi.login → 存 token → 进后台。与 C 端手机验证码无关。
export default function AdminLoginPage() {
  const router = useRouter()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const { token } = await adminApi.login(username, password)
      adminTokenStore.set(token)
      router.replace("/")
    } catch {
      setError("账号或密码错误")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4 rounded-2xl border border-border bg-card p-8 shadow-sm">
        <div>
          <h1 className="text-lg font-semibold text-foreground">运营后台登录</h1>
          <p className="mt-1 text-xs text-muted-foreground">仅限授权运营人员 · 与 C 端账号无关</p>
        </div>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="账号"
          autoComplete="username"
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="密码"
          autoComplete="current-password"
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        <button
          type="submit"
          disabled={loading || !username || !password}
          className="w-full rounded-lg bg-primary py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          {loading ? "登录中…" : "登录"}
        </button>
      </form>
    </div>
  )
}
