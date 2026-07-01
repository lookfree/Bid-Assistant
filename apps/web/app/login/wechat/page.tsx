"use client"
import { Suspense, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { api } from "@/lib/api"
import { authErrorMessage } from "@/lib/auth-errors"
import { useAuth } from "@/components/auth/auth-provider"

// 微信授权回跳页：读 code/state → 换登录 → 落态跳转。开发期用伪 code + 真 state 即可联调。
function WechatCallbackContent() {
  const params = useSearchParams()
  const router = useRouter()
  const { login } = useAuth()
  const [msg, setMsg] = useState("正在登录…")

  useEffect(() => {
    const code = params.get("code")
    const state = params.get("state")
    if (!code || !state) {
      setMsg("缺少授权参数")
      return
    }
    api.authApi
      .wechatLogin(code, state)
      .then(({ token, user, isNew }) => {
        login(token, user)
        router.replace(isNew ? "/upload" : "/projects")
      })
      .catch((e) => setMsg(authErrorMessage(e, "微信登录失败，请重试")))
  }, [params, router, login])

  return <div className="p-8 text-center text-muted-foreground">{msg}</div>
}

export default function WechatCallbackPage() {
  return (
    <Suspense fallback={null}>
      <WechatCallbackContent />
    </Suspense>
  )
}
