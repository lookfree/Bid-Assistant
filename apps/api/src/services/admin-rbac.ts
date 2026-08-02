import { getConfig, setConfig } from "./config"
import { PERMISSIONS, ROLE_PERMISSIONS, type Permission } from "./rbac"
import type { AdminRole } from "../db/schema"

// 可编辑 RBAC（2026-08-02）：角色→权限从硬编码矩阵升级为后台可编辑配置（billing_configs
// key="admin_rbac"，形如 {finance:[...], ops:[...], support:[...]}）。rbac.ts 的 ROLE_PERMISSIONS
// 降级为**出厂默认值**：未配置/某角色缺失时按默认走，存量部署行为不变。
// superadmin 恒全权、不落库不可编辑——防止把唯一能改权限的角色改瘸导致全局锁死。

export const RBAC_CONFIG_KEY = "admin_rbac"
export const EDITABLE_ROLES = ["finance", "ops", "support"] as const
export type EditableRole = (typeof EDITABLE_ROLES)[number]

export class InvalidRbacError extends Error {}

// 60s 短缓存（与免费档 features 同法）：每个 admin 请求都要过权限判定，准静态配置不逐请求打库。
let cache: { value: Record<EditableRole, Permission[]>; exp: number } | null = null

/** 测试用：清缓存（测试内改矩阵后立即生效，不等 TTL）。saveRoleMatrix 保存后也会调用。 */
export function resetRbacCache(): void {
  cache = null
}

async function editableMatrix(): Promise<Record<EditableRole, Permission[]>> {
  if (cache == null || cache.exp < Date.now()) {
    const stored = await getConfig<Record<string, unknown>>(RBAC_CONFIG_KEY)
    const value = {} as Record<EditableRole, Permission[]>
    for (const role of EDITABLE_ROLES) {
      const raw = stored?.[role]
      // 只认白名单里的权限点（历史配置里已删除的权限静默剔除,不因脏数据瘫掉判定）
      value[role] = Array.isArray(raw)
        ? (raw.filter((p) => (PERMISSIONS as readonly string[]).includes(p as string)) as Permission[])
        : ROLE_PERMISSIONS[role]
    }
    cache = { value, exp: Date.now() + 60_000 }
  }
  return cache.value
}

/** 全角色生效矩阵（superadmin 恒全权拼在结果里，供 /rbac 展示与 /me 下发）。 */
export async function getRoleMatrix(): Promise<Record<AdminRole, Permission[]>> {
  const m = await editableMatrix()
  return { superadmin: [...PERMISSIONS], ...m }
}

/** 角色是否持有权限（DB 配置版；requirePermission 中间件用）。 */
export async function roleHasPermission(role: AdminRole, perm: Permission): Promise<boolean> {
  if (role === "superadmin") return true
  const m = await editableMatrix()
  return m[role as EditableRole]?.includes(perm) ?? false
}

/** 保存可编辑角色的权限矩阵。校验：角色必须齐全、权限点必须在白名单——宁拒不脏。
 *  superadmin 不接受入参（恒全权）；admin.manage 不允许授予任何可编辑角色（架构 §3.3：
 *  账号管理仅 superadmin，把它配出去等于多造一个超管）。 */
export async function saveRoleMatrix(input: Record<string, unknown>): Promise<void> {
  const clean = {} as Record<EditableRole, Permission[]>
  for (const role of EDITABLE_ROLES) {
    const raw = input[role]
    if (!Array.isArray(raw)) throw new InvalidRbacError(`缺少角色 ${role} 的权限列表`)
    const dedup = [...new Set(raw.map(String))]
    for (const p of dedup) {
      if (!(PERMISSIONS as readonly string[]).includes(p)) throw new InvalidRbacError(`未知权限点: ${p}`)
      if (p === "admin.manage") throw new InvalidRbacError("admin.manage 仅 superadmin 持有，不可配置给其他角色")
    }
    clean[role] = dedup as Permission[]
  }
  await setConfig(RBAC_CONFIG_KEY, clean)
  resetRbacCache()
}
