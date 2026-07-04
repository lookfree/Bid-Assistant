import type { AdminRole } from "../db/schema"

// RBAC 角色→权限映射（spec309）：细粒度权限枚举，spec310 各功能路由按需 requirePermission 引用。

export const PERMISSIONS = [
  "user.read",
  "user.write", // 用户/会员（封禁/调整）
  "order.read",
  "refund.write", // 订单/退款/对账
  "ledger.read",
  "credit.adjust", // 积分账本/手动调积分
  "plan.write", // 套餐与积分口径
  "config.write", // billing_configs 配置
  "referral.write", // 手动发邀请奖励
  "audit.read", // 审计查看
  "admin.manage", // 系统/账号管理（仅 superadmin；spec310 账号管理页）
] as const
export type Permission = (typeof PERMISSIONS)[number]

// superadmin 全权（含 admin.manage）；其余角色一律不含 admin.manage（架构 §3.3 / §5.2）。
export const ROLE_PERMISSIONS: Record<AdminRole, Permission[]> = {
  superadmin: [...PERMISSIONS],
  finance: ["order.read", "refund.write", "ledger.read", "audit.read"],
  ops: ["user.read", "user.write", "plan.write", "config.write", "ledger.read", "audit.read"], // ops 管用户/套餐/配置（spec310 角色模型）

  support: ["user.read", "order.read", "ledger.read"], // 只读 + 客服
}

export function hasPermission(role: AdminRole, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(perm) ?? false
}
