"use client"

import { useCallback, useEffect, useState } from "react"
import { fetchMembership } from "./membership-api"
import { isMember } from "./membership-view"
import { tokenStore } from "./token-store"
import type { MembershipOverview } from "./membership-types"

// ============ 模块级共享 store：全站积分/会员信息的**唯一来源** ============
// 生产实测：同屏出现两个不同余额（侧边栏 9,910 vs 底部栏 9,930）——各组件实例虽调同一接口，
// 但各持一份 state 快照、各自独立刷新，时机一错就分叉。收敛为单一缓存 + 订阅广播：
// 任何一处触发刷新（credits:refresh 事件 / reload()），只发**一次**请求（并发合并），
// 结果广播给所有挂载中的 useMembership 实例——所有积分展示永远同值。
let cachedOverview: MembershipOverview | null = null
const subscribers = new Set<(ov: MembershipOverview | null) => void>()
let inflight: Promise<void> | null = null

function broadcast(): void {
  for (const fn of subscribers) fn(cachedOverview)
}

/** 共享刷新：无 token 清空广播；在途请求直接复用（N 个组件同时触发也只打一次接口）。 */
function refreshShared(): Promise<void> {
  if (!tokenStore.get()) {
    cachedOverview = null
    broadcast()
    return Promise.resolve()
  }
  if (inflight) return inflight
  inflight = fetchMembership()
    .then((ov) => {
      cachedOverview = ov
      broadcast()
    })
    .catch(() => {}) // 静默失败：保留旧缓存（首次失败由 hook 侧给 error 文案）
    .finally(() => {
      inflight = null
    })
  return inflight
}

// 全局扣费事件 → 一次共享刷新（模块级只挂一次监听；步骤完成/改写/导出等扣费点都广播此事件）
if (typeof window !== "undefined") {
  window.addEventListener("credits:refresh", () => void refreshShared())
}

/** 只读窥视缓存（会员中心页秒开用：先渲染缓存,后台刷新校准;未拉过返回 null）。 */
export function peekMembershipCache(): MembershipOverview | null {
  return cachedOverview
}

/** 页面自拉到新 overview 后回写共享缓存并广播（会员中心页 load() 用,保持各页一致）。 */
export function primeMembershipCache(ov: MembershipOverview): void {
  cachedOverview = ov
  broadcast()
}

/** 登录态切换时清缓存（auth-provider login/logout 调）：模块缓存跨用户存活,
 *  不清会把上个账号的余额/套餐闪现给下个账号。 */
export function clearMembershipCache(): void {
  cachedOverview = null
  broadcast()
}

/**
 * 工具页共用：真实积分余额与会员身份（GET /api/membership）——全站唯一数据源。
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
    const sub = (ov: MembershipOverview | null) => {
      if (!alive) return
      setOverview(ov)
      if (ov !== null) {
        setError(null)
        setLoading(false)
      }
    }
    subscribers.add(sub)
    if (!tokenStore.get()) {
      cachedOverview = null
      setOverview(null)
      setLoading(false)
    } else {
      void refreshShared().finally(() => {
        if (!alive) return
        setLoading(false)
        // 冷启动（无缓存）且刷新后仍无数据 = 首次拉取失败：给可见错误（老语义保留）
        if (cachedOverview === null) setError("会员信息加载失败，请刷新重试")
      })
    }
    return () => {
      alive = false
      subscribers.delete(sub)
    }
  }, [])

  // 主动刷新（余额变动后调用，如单章改写扣费）：走共享刷新，所有实例一起更新。
  const reload = useCallback(() => {
    void refreshShared()
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
