"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { adminApi } from "@/lib/admin-api"
import { adminTokenStore } from "@/lib/admin-token-store"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

// 运营后台登录（spec309）：账号 + 密码 → adminApi.login → 存 token → 进后台。与 C 端手机验证码无关。
// UI 复用原型 shadcn 组件（Button/Input/Card），与后台整体风格一致。
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
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>运营后台登录</CardTitle>
          <CardDescription>仅限授权运营人员 · 与 C 端账号无关</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="username">账号</Label>
              <Input id="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">密码</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={loading || !username || !password} className="w-full">
              {loading ? "登录中…" : "登录"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
