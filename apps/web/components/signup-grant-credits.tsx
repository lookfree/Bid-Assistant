"use client"

import { useEffect, useState } from "react"
import { fetchPublicConfig } from "@/lib/public-config"

/** 注册赠送积分数值（后台 signup_grant_credits 实时值）：渲染纯数字，供首页文案内嵌。
 *  fallback 200——加载中/拉取失败不露破绽。在 Server Component 里作为 client 子组件使用。 */
export function SignupGrantCredits() {
  const [n, setN] = useState(200)
  useEffect(() => {
    let alive = true
    fetchPublicConfig()
      .then((c) => {
        if (alive && typeof c.signupGrantCredits === "number") setN(c.signupGrantCredits)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  return <>{n}</>
}
