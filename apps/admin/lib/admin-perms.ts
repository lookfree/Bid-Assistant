"use client"

import { useSyncExternalStore } from "react"

// 当前 admin 的生效权限集（2026-08-02 可编辑 RBAC）：由 RequireAdmin 登录校验时从 /me 一次性
// 写入,菜单过滤与按钮禁用都读这里——前端**不复制**角色→权限矩阵（复制必漂移）,唯一权威是服务端。
// null = 尚未加载（登录校验中）：菜单先只渲染无权限要求的项,加载完再展开,避免闪现越权入口。

let perms: string[] | null = null
const listeners = new Set<() => void>()

export function setAdminPermissions(next: string[] | null): void {
  perms = next
  for (const l of listeners) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** 当前权限集（null=未加载）。 */
export function usePermissions(): string[] | null {
  return useSyncExternalStore(subscribe, () => perms, () => perms)
}

/** 组件内判定：有没有某权限点（未加载一律 false——按钮宁可先禁用后启用,不闪现可点态）。 */
export function useCan(): (perm: string) => boolean {
  const p = usePermissions()
  return (perm: string) => p?.includes(perm) ?? false
}

/** 按权限集过滤菜单（纯函数）：perm 缺省=登录即可见;perms=null(未加载)只留无权限要求的项——
 *  宁可先少显后展开,不闪现越权入口。侧边栏与单测共用。 */
export function visibleNav<T extends { perm?: string }>(items: T[], perms: string[] | null): T[] {
  return items.filter((it) => !it.perm || (perms?.includes(it.perm) ?? false))
}
