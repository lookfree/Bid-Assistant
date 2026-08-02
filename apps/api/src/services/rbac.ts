import type { AdminRole } from "../db/schema"

// RBAC 权限点枚举 + 角色**出厂默认**映射（spec309/spec310）。
// 2026-08-02 起角色→权限可在后台编辑（services/admin-rbac.ts,落 billing_configs）：
// 本表降级为未配置时的默认值;hasPermission(同步版)只供测试/种子用,线上判定走 roleHasPermission。

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
  "feedback.read",
  "feedback.write", // 反馈/投诉处理（spec326：算法备案要求处理可追溯）
  "invoice.write", // 开具/驳回发票（spec332；发票属财务，授予 finance）
  "category.read", // 标书分类纠偏样本查看（spec334；运营改提示词的反馈回路，授予 ops）
] as const
export type Permission = (typeof PERMISSIONS)[number]

// superadmin 全权（含 admin.manage）；其余角色一律不含 admin.manage（架构 §3.3 / §5.2）。
export const ROLE_PERMISSIONS: Record<AdminRole, Permission[]> = {
  superadmin: [...PERMISSIONS],
  finance: ["order.read", "refund.write", "ledger.read", "audit.read", "invoice.write"],
  ops: ["user.read", "user.write", "plan.write", "config.write", "ledger.read", "audit.read", "feedback.read", "feedback.write", "category.read"], // ops 管用户/套餐/配置（spec310 角色模型）
  support: ["user.read", "order.read", "ledger.read", "feedback.read", "feedback.write"], // 只读 + 客服；处理反馈工单是 support 唯一的写权限（有意例外，spec326）
}

export function hasPermission(role: AdminRole, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(perm) ?? false
}
