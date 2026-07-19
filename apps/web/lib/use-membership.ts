"use client"

import { useCallback, useEffect, useState } from "react"
import { fetchMembership } from "./membership-api"
import { isMember } from "./membership-view"
import { tokenStore } from "./token-store"
import type { MembershipOverview } from "./membership-types"

// 模块级缓存：跨页面共享上次拉到的 overview，挂载先用缓存立即渲染，再后台刷新。
let cachedOverview: MembershipOverview | null = null

/** 只读窥视缓存（会员中心页秒开用：先渲染缓存,后台刷新校准;未拉过返回 null）。 */
export function peekMembershipCache(): MembershipOverview | null {
  return cachedOverview
}

/** 页面自拉到新 overview 后回写共享缓存（会员中心页 load() 用,保持各页一致）。 */
export function primeMembershipCache(ov: MembershipOverview): void {
  cachedOverview = ov
}

/** 登录态切换时清缓存（auth-provider login/logout 调）：模块缓存跨用户存活,
 *  不清会把上个账号的余额/套餐闪现给下个账号。 */
export function clearMembershipCache(): void {
  cachedOverview = null
}

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

  // 主动刷新（余额变动后调用，如单章改写扣费）：静默重拉并更新跨页缓存。
  const reload = useCallback(() => {
    if (!tokenStore.get()) return
    fetchMembership()
      .then((ov) => {
        cachedOverview = ov
        setOverview(ov)
        setError(null)
      })
      .catch(() => {})
  }, [])

  return {
    overview,
    loading,
    error,
    reload,
    balance: overview?.balance ?? 0,
    isMember: isMember(overview),
  }
}
