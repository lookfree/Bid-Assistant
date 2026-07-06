"use client"

import { useEffect, useState } from "react"
import { fetchMembership } from "./membership-api"
import { isMember } from "./membership-view"
import { tokenStore } from "./token-store"
import type { MembershipOverview } from "./membership-types"

// 模块级缓存：跨页面共享上次拉到的 overview，挂载先用缓存立即渲染，再后台刷新。
let cachedOverview: MembershipOverview | null = null

/**
 * 工具页共用：真实积分余额与会员身份（GET /api/membership）。
 * - loading 仅在无缓存的首次拉取期间为 true（有缓存时后台静默刷新）；
 * - 登出/无 token 时不发请求并清缓存，按免费口径展示（余额 0、非会员）；
 * - 会员判定见 membership-view.isMember：仅 active 算会员权益。
 */
export function useMembership() {
  const [overview, setOverview] = useState<MembershipOverview | null>(cachedOverview)
  const [loading, setLoading] = useState(cachedOverview === null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    if (!tokenStore.get()) {
      cachedOverview = null
      setOverview(null)
      setLoading(false)
      return
    }
    fetchMembership()
      .then((ov) => {
        cachedOverview = ov
        if (alive) {
          setOverview(ov)
          setError(null)
        }
      })
      .catch(() => {
        if (alive) setError("会员信息加载失败，请刷新重试")
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  return {
    overview,
    loading,
    error,
    balance: overview?.balance ?? 0,
    isMember: isMember(overview),
  }
}
