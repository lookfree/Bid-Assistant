// 运营后台展示中文映射（bug：权限项/操作/变更前后此前直出英文键与裸 JSON，运营看不懂）。
// 权威枚举在 apps/api（rbac 权限、writeAudit action）；这里是展示副本,新增枚举须同步补齐,
// 未命中的键回退原字符串（宁可显示英文键,不隐藏未知项）。

/** 权限项（RBAC）中文名。 */
export const PERM_LABELS: Record<string, string> = {
  "admin.manage": "管理员账号管理",
  "audit.read": "查看审计日志",
  "config.write": "写入系统配置",
  "credit.adjust": "手动调整积分",
  "feedback.read": "查看反馈工单",
  "feedback.write": "处理反馈工单",
  "ledger.read": "查看积分账本",
  "order.read": "查看订单",
  "plan.write": "编辑套餐与积分口径",
  "referral.write": "配置邀请奖励",
  "refund.write": "发起退款",
  "user.read": "查看用户",
  "user.write": "管理用户（封禁/编辑）",
}

/** 审计日志「操作」中文名。 */
export const ACTION_LABELS: Record<string, string> = {
  "admin.manage": "管理员账号变更",
  "config.write": "修改系统配置",
  "credit.adjust": "手动调整积分",
  "diff.fix_unknown_paid": "修复未知已支付订单",
  "diff.resolve": "处理对账差异",
  "feedback.handle": "处理反馈工单",
  "plan.write": "修改套餐配置",
  "refund.ambiguous": "退款结果待核对",
  "refund.done": "退款成功",
  "refund.failed": "退款失败",
  "refund.write": "发起退款",
  "user.write": "用户管理操作",
}

/** 审计快照里常见字段名 → 中文（before/after 展开时用；未命中回退原键）。 */
const FIELD_LABELS: Record<string, string> = {
  status: "状态",
  balance: "余额",
  amount: "金额",
  priceCents: "价格(分)",
  grantCreditsPerCycle: "每周期赠送积分",
  role: "角色",
  reason: "原因",
  inviterReward: "邀请人奖励",
  inviteeReward: "被邀请人奖励",
  capPerUser: "单用户封顶",
  unlockOn: "解锁方式",
  abandonDays: "注册即弃天数",
}

export const permLabel = (p: string) => PERM_LABELS[p] ?? p
export const actionLabel = (a: string) => ACTION_LABELS[a] ?? a
export const fieldLabel = (k: string) => FIELD_LABELS[k] ?? k

/** 审计快照（before/after）→ 可读键值行,替代裸 JSON。返回 [{label, value}]（对象展开逐字段；
 *  标量单行；空/undefined 返回空数组由调用方显示占位）。 */
export function snapshotRows(snap: unknown): { label: string; value: string }[] {
  if (snap == null) return []
  if (typeof snap !== "object") return [{ label: "", value: String(snap) }]
  return Object.entries(snap as Record<string, unknown>).map(([k, v]) => ({
    label: fieldLabel(k),
    value: v == null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v),
  }))
}
