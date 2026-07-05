// 智启元 · 运营后台 —— 纯前端 mock 数据
// 数据基于真实公司名构造，仅用于原型演示

export type MemberTier = "free" | "personal" | "pro"
export type AccountStatus = "active" | "banned"

export const tierLabel: Record<MemberTier, string> = {
  free: "免费版",
  personal: "个人版",
  pro: "专业版",
}

export interface UserRow {
  id: string
  phone: string
  name: string
  company: string
  registeredAt: string
  tier: MemberTier
  points: number
  autoRenew: boolean
  status: AccountStatus
  projects: number
  subscription: {
    plan: MemberTier
    period: "月付" | "年付"
    startAt: string
    nextRenewAt: string
    amount: number
  }
}

export const users: UserRow[] = [
  {
    id: "U100237",
    phone: "138****6621",
    name: "张文涛",
    company: "中建三局集团有限公司",
    registeredAt: "2025-03-12 09:24",
    tier: "pro",
    points: 19420,
    autoRenew: true,
    status: "active",
    projects: 36,
    subscription: { plan: "pro", period: "年付", startAt: "2025-06-01", nextRenewAt: "2026-06-01", amount: 5988 },
  },
  {
    id: "U100412",
    phone: "139****1188",
    name: "李慧敏",
    company: "华为技术有限公司",
    registeredAt: "2025-04-02 14:11",
    tier: "pro",
    points: 9260,
    autoRenew: true,
    status: "active",
    projects: 21,
    subscription: { plan: "pro", period: "月付", startAt: "2026-06-08", nextRenewAt: "2026-07-08", amount: 599 },
  },
  {
    id: "U100876",
    phone: "137****9032",
    name: "王建国",
    company: "中国电建集团华东勘测设计研究院",
    registeredAt: "2025-01-20 10:48",
    tier: "personal",
    points: 1240,
    autoRenew: false,
    status: "active",
    projects: 8,
    subscription: { plan: "personal", period: "月付", startAt: "2026-06-15", nextRenewAt: "2026-07-15", amount: 99 },
  },
  {
    id: "U101205",
    phone: "150****7745",
    name: "陈雅芝",
    company: "上海建工集团股份有限公司",
    registeredAt: "2025-05-18 16:33",
    tier: "personal",
    points: 320,
    autoRenew: true,
    status: "active",
    projects: 5,
    subscription: { plan: "personal", period: "年付", startAt: "2026-02-01", nextRenewAt: "2027-02-01", amount: 990 },
  },
  {
    id: "U101533",
    phone: "188****2210",
    name: "刘振华",
    company: "比亚迪股份有限公司",
    registeredAt: "2025-06-01 08:05",
    tier: "free",
    points: 60,
    autoRenew: false,
    status: "active",
    projects: 2,
    subscription: { plan: "free", period: "月付", startAt: "2025-06-01", nextRenewAt: "-", amount: 0 },
  },
  {
    id: "U101840",
    phone: "136****5567",
    name: "赵明远",
    company: "中铁建工集团有限公司",
    registeredAt: "2024-11-09 13:52",
    tier: "pro",
    points: 24680,
    autoRenew: true,
    status: "active",
    projects: 52,
    subscription: { plan: "pro", period: "年付", startAt: "2025-11-09", nextRenewAt: "2026-11-09", amount: 5988 },
  },
  {
    id: "U102119",
    phone: "199****3301",
    name: "孙倩",
    company: "京东科技信息技术有限公司",
    registeredAt: "2025-02-26 11:20",
    tier: "personal",
    points: 0,
    autoRenew: false,
    status: "banned",
    projects: 14,
    subscription: { plan: "personal", period: "月付", startAt: "2026-05-15", nextRenewAt: "2026-06-15", amount: 99 },
  },
  {
    id: "U102457",
    phone: "151****8890",
    name: "周浩然",
    company: "三一重工股份有限公司",
    registeredAt: "2025-05-30 19:41",
    tier: "free",
    points: 180,
    autoRenew: false,
    status: "active",
    projects: 3,
    subscription: { plan: "free", period: "月付", startAt: "2025-05-30", nextRenewAt: "-", amount: 0 },
  },
  {
    id: "U102688",
    phone: "133****4412",
    name: "吴丽娟",
    company: "万科企业股份有限公司",
    registeredAt: "2025-04-15 15:08",
    tier: "pro",
    points: 7320,
    autoRenew: false,
    status: "active",
    projects: 19,
    subscription: { plan: "pro", period: "月付", startAt: "2026-06-10", nextRenewAt: "2026-07-10", amount: 599 },
  },
  {
    id: "U102910",
    phone: "186****0023",
    name: "郑凯",
    company: "海康威视数字技术股份有限公司",
    registeredAt: "2025-03-28 09:59",
    tier: "personal",
    points: 2480,
    autoRenew: true,
    status: "active",
    projects: 11,
    subscription: { plan: "personal", period: "年付", startAt: "2026-03-28", nextRenewAt: "2027-03-28", amount: 990 },
  },
  {
    id: "U103144",
    phone: "135****6678",
    name: "冯晓东",
    company: "格力电器股份有限公司",
    registeredAt: "2025-06-12 10:30",
    tier: "free",
    points: 100,
    autoRenew: false,
    status: "active",
    projects: 1,
    subscription: { plan: "free", period: "月付", startAt: "2025-06-12", nextRenewAt: "-", amount: 0 },
  },
  {
    id: "U103399",
    phone: "180****9911",
    name: "黄诗韵",
    company: "中国中铁股份有限公司",
    registeredAt: "2025-01-08 17:22",
    tier: "pro",
    points: 13900,
    autoRenew: true,
    status: "active",
    projects: 41,
    subscription: { plan: "pro", period: "年付", startAt: "2026-01-08", nextRenewAt: "2027-01-08", amount: 5988 },
  },
]

// ---------------- 积分账本（只追加） ----------------
export type LedgerType = "grant" | "purchase" | "hold" | "settle" | "release" | "expire" | "referral_reward" | "refund_clawback" | "admin_adjust"

export const ledgerTypeLabel: Record<LedgerType, string> = {
  grant: "赠送",
  purchase: "充值",
  hold: "预扣",
  settle: "结算",
  release: "退还",
  expire: "过期",
  referral_reward: "推荐奖励",
  refund_clawback: "退款回收",
  admin_adjust: "手动调整",
}

export interface LedgerEntry {
  id: string
  userId: string
  userName: string
  type: LedgerType
  amount: number // 带正负
  batch: string // 来源批次
  ref: string // 关联 run / 订单
  idempotencyKey: string
  createdAt: string
}

export const ledger: LedgerEntry[] = [
  { id: "L900145", userId: "U100237", userName: "张文涛", type: "grant", amount: 5000, batch: "B-2025Q2-GRANT", ref: "SUB-100237", idempotencyKey: "idem-9f2a01", createdAt: "2025-06-01 00:01" },
  { id: "L900146", userId: "U100237", userName: "张文涛", type: "purchase", amount: 20000, batch: "B-RECHARGE", ref: "ORD-20260618-0012", idempotencyKey: "idem-9f2a02", createdAt: "2026-06-18 10:24" },
  { id: "L900147", userId: "U100237", userName: "张文涛", type: "hold", amount: -1200, batch: "RUN", ref: "run_8841aa", idempotencyKey: "idem-9f2a03", createdAt: "2026-06-20 14:02" },
  { id: "L900148", userId: "U100237", userName: "张文涛", type: "settle", amount: -3380, batch: "RUN", ref: "run_8841aa", idempotencyKey: "idem-9f2a04", createdAt: "2026-06-20 14:39" },
  { id: "L900149", userId: "U100237", userName: "张文涛", type: "release", amount: 1200, batch: "RUN", ref: "run_8841aa", idempotencyKey: "idem-9f2a05", createdAt: "2026-06-20 14:39" },
  { id: "L900150", userId: "U100237", userName: "张文涛", type: "settle", amount: -2200, batch: "RUN", ref: "run_8852bc", idempotencyKey: "idem-9f2a06", createdAt: "2026-06-22 09:18" },
  { id: "L900151", userId: "U100412", userName: "李慧敏", type: "grant", amount: 3000, batch: "B-2025Q2-GRANT", ref: "SUB-100412", idempotencyKey: "idem-7c1b01", createdAt: "2026-06-08 00:01" },
  { id: "L900152", userId: "U100412", userName: "李慧敏", type: "purchase", amount: 8000, batch: "B-RECHARGE", ref: "ORD-20260619-0031", idempotencyKey: "idem-7c1b02", createdAt: "2026-06-19 16:40" },
  { id: "L900153", userId: "U100412", userName: "李慧敏", type: "settle", amount: -1740, batch: "RUN", ref: "run_77a2de", idempotencyKey: "idem-7c1b03", createdAt: "2026-06-23 11:02" },
  { id: "L900154", userId: "U100876", userName: "王建国", type: "grant", amount: 1000, batch: "B-2025Q2-GRANT", ref: "SUB-100876", idempotencyKey: "idem-3d4e01", createdAt: "2026-06-15 00:01" },
  { id: "L900155", userId: "U100876", userName: "王建国", type: "settle", amount: -760, batch: "RUN", ref: "run_55c3ef", idempotencyKey: "idem-3d4e02", createdAt: "2026-06-21 15:33" },
  { id: "L900156", userId: "U100876", userName: "王建国", type: "expire", amount: -200, batch: "B-EXPIRE-202606", ref: "exp-202606", idempotencyKey: "idem-3d4e03", createdAt: "2026-06-30 23:59" },
  { id: "L900157", userId: "U101840", userName: "赵明远", type: "grant", amount: 5000, batch: "B-2025Q4-GRANT", ref: "SUB-101840", idempotencyKey: "idem-1a8f01", createdAt: "2025-11-09 00:01" },
  { id: "L900158", userId: "U101840", userName: "赵明远", type: "purchase", amount: 30000, batch: "B-RECHARGE", ref: "ORD-20260620-0044", idempotencyKey: "idem-1a8f02", createdAt: "2026-06-20 09:12" },
  { id: "L900159", userId: "U101840", userName: "赵明远", type: "hold", amount: -3200, batch: "RUN", ref: "run_9a01bb", idempotencyKey: "idem-1a8f03", createdAt: "2026-06-24 10:50" },
  { id: "L900160", userId: "U101840", userName: "赵明远", type: "settle", amount: -6920, batch: "RUN", ref: "run_9a01bb", idempotencyKey: "idem-1a8f04", createdAt: "2026-06-24 11:48" },
  { id: "L900161", userId: "U101840", userName: "赵明远", type: "release", amount: 3200, batch: "RUN", ref: "run_9a01bb", idempotencyKey: "idem-1a8f05", createdAt: "2026-06-24 11:48" },
  { id: "L900162", userId: "U102688", userName: "吴丽娟", type: "grant", amount: 3000, batch: "B-2025Q2-GRANT", ref: "SUB-102688", idempotencyKey: "idem-6b2c01", createdAt: "2026-06-10 00:01" },
  { id: "L900163", userId: "U102688", userName: "吴丽娟", type: "settle", amount: -1480, batch: "RUN", ref: "run_44d5aa", idempotencyKey: "idem-6b2c02", createdAt: "2026-06-25 13:20" },
]

// 用户余额核对：流水之和
export function balanceFromLedger(userId: string): number {
  return ledger.filter((l) => l.userId === userId).reduce((sum, l) => sum + l.amount, 0)
}

// ---------------- 订单与对账 ----------------
export type OrderType = "recharge" | "single" | "renew"
export type OrderStatus = "paid" | "pending" | "refunded" | "failed"
export type ReconcileStatus = "matched" | "diff"

export const orderTypeLabel: Record<OrderType, string> = {
  recharge: "积分充值",
  single: "单笔购买",
  renew: "自动续费",
}
export const orderStatusLabel: Record<OrderStatus, string> = {
  paid: "已支付",
  pending: "待支付",
  refunded: "已退款",
  failed: "支付失败",
}

export interface OrderRow {
  id: string
  userId: string
  company: string
  type: OrderType
  amount: number
  status: OrderStatus
  alipayTradeNo: string
  reconcile: ReconcileStatus
  createdAt: string
}

export const orders: OrderRow[] = [
  { id: "ORD-20260620-0044", userId: "U101840", company: "中铁建工集团有限公司", type: "recharge", amount: 2999, status: "paid", alipayTradeNo: "2026062022001440021547", reconcile: "matched", createdAt: "2026-06-20 09:12" },
  { id: "ORD-20260619-0031", userId: "U100412", company: "华为技术有限公司", type: "recharge", amount: 799, status: "paid", alipayTradeNo: "2026061922001440019823", reconcile: "matched", createdAt: "2026-06-19 16:40" },
  { id: "ORD-20260618-0012", userId: "U100237", company: "中建三局集团有限公司", type: "recharge", amount: 1999, status: "paid", alipayTradeNo: "2026061822001440016602", reconcile: "diff", createdAt: "2026-06-18 10:24" },
  { id: "ORD-20260625-0067", userId: "U102688", company: "万科企业股份有限公司", type: "renew", amount: 599, status: "paid", alipayTradeNo: "2026062522001440028841", reconcile: "matched", createdAt: "2026-06-25 06:00" },
  { id: "ORD-20260625-0071", userId: "U101205", company: "上海建工集团股份有限公司", type: "single", amount: 199, status: "pending", alipayTradeNo: "-", reconcile: "diff", createdAt: "2026-06-25 11:32" },
  { id: "ORD-20260624-0058", userId: "U102910", company: "海康威视数字技术股份有限公司", type: "renew", amount: 990, status: "paid", alipayTradeNo: "2026062422001440025513", reconcile: "matched", createdAt: "2026-06-24 06:00" },
  { id: "ORD-20260623-0049", userId: "U100876", company: "中国电建集团华东勘测设计研究院", type: "single", amount: 49, status: "refunded", alipayTradeNo: "2026062322001440023390", reconcile: "matched", createdAt: "2026-06-23 14:18" },
  { id: "ORD-20260622-0040", userId: "U103399", company: "中国中铁股份有限公司", type: "recharge", amount: 4999, status: "paid", alipayTradeNo: "2026062222001440021008", reconcile: "matched", createdAt: "2026-06-22 08:45" },
  { id: "ORD-20260621-0033", userId: "U102119", company: "京东科技信息技术有限公司", type: "single", amount: 99, status: "failed", alipayTradeNo: "-", reconcile: "matched", createdAt: "2026-06-21 20:11" },
  { id: "ORD-20260620-0029", userId: "U102910", company: "海康威视数字技术股份有限公司", type: "recharge", amount: 299, status: "paid", alipayTradeNo: "2026062022001440017745", reconcile: "diff", createdAt: "2026-06-20 13:50" },
]

// ---------------- 套餐 & 积分口径配置 ----------------
export interface PlanConfig {
  tier: MemberTier
  name: string
  monthly: number
  yearly: number
  monthlyPoints: number
  parallelProjects: number
  features: { rewrite: boolean; dedupe: boolean; export: boolean; priority: boolean }
}

export const planConfigs: PlanConfig[] = [
  { tier: "free", name: "免费版", monthly: 0, yearly: 0, monthlyPoints: 200, parallelProjects: 1, features: { rewrite: false, dedupe: false, export: false, priority: false } },
  { tier: "personal", name: "个人版", monthly: 99, yearly: 990, monthlyPoints: 3000, parallelProjects: 3, features: { rewrite: true, dedupe: true, export: true, priority: false } },
  { tier: "pro", name: "专业版", monthly: 599, yearly: 5988, monthlyPoints: 20000, parallelProjects: 10, features: { rewrite: true, dedupe: true, export: true, priority: true } },
]

export interface PointRule {
  key: string
  name: string
  desc: string
  cost: number
}

export const pointRules: PointRule[] = [
  { key: "read", name: "读标", desc: "解析招标文件并提取要点", cost: 50 },
  { key: "outline", name: "提纲", desc: "生成投标文件章节提纲", cost: 120 },
  { key: "short", name: "短篇生成", desc: "单章节 / 短文本生成", cost: 200 },
  { key: "long", name: "长篇生成", desc: "整本投标文件生成", cost: 1500 },
  { key: "rewrite", name: "重写", desc: "对已生成内容进行重写优化", cost: 80 },
  { key: "review", name: "废标审查", desc: "废标风险点扫描", cost: 300 },
  { key: "dedupe", name: "查重", desc: "全文查重比对", cost: 260 },
  { key: "export", name: "导出", desc: "导出为 Word / PDF", cost: 30 },
]

// ---------------- 系统 & 权限 ----------------
export type RoleKey = "superadmin" | "ops" | "finance" | "support"

export const roleLabel: Record<RoleKey, string> = {
  superadmin: "超级管理员",
  ops: "运营",
  finance: "财务",
  support: "客服",
}

export interface OpsAccount {
  id: string
  name: string
  email: string
  role: RoleKey
  status: "active" | "disabled"
  lastLogin: string
}

export const opsAccounts: OpsAccount[] = [
  { id: "A001", name: "顾屿安", email: "guyuan@zhiqiyuan.com", role: "superadmin", status: "active", lastLogin: "2026-06-25 09:02" },
  { id: "A002", name: "林晚舟", email: "linwz@zhiqiyuan.com", role: "ops", status: "active", lastLogin: "2026-06-25 08:41" },
  { id: "A003", name: "沈知行", email: "shenzx@zhiqiyuan.com", role: "finance", status: "active", lastLogin: "2026-06-24 18:20" },
  { id: "A004", name: "苏晴", email: "suqing@zhiqiyuan.com", role: "support", status: "active", lastLogin: "2026-06-25 07:55" },
  { id: "A005", name: "陆则铭", email: "luzm@zhiqiyuan.com", role: "ops", status: "disabled", lastLogin: "2026-05-30 14:12" },
]

export const permissionGroups = [
  {
    group: "用户管理",
    perms: [
      { key: "user.view", name: "查看用户" },
      { key: "user.points", name: "调整积分" },
      { key: "user.ban", name: "封禁 / 解封" },
    ],
  },
  {
    group: "订单财务",
    perms: [
      { key: "order.view", name: "查看订单" },
      { key: "order.refund", name: "发起退款" },
      { key: "order.reconcile", name: "对账操作" },
    ],
  },
  {
    group: "配置管理",
    perms: [
      { key: "plan.edit", name: "修改套餐" },
      { key: "points.edit", name: "修改积分口径" },
    ],
  },
  {
    group: "系统权限",
    perms: [
      { key: "system.account", name: "运营账号管理" },
      { key: "system.audit", name: "查看审计日志" },
    ],
  },
]

// 各角色默认权限
export const rolePermissions: Record<RoleKey, string[]> = {
  superadmin: ["user.view", "user.points", "user.ban", "order.view", "order.refund", "order.reconcile", "plan.edit", "points.edit", "system.account", "system.audit"],
  ops: ["user.view", "user.points", "user.ban", "order.view", "plan.edit", "points.edit"],
  finance: ["order.view", "order.refund", "order.reconcile", "user.view", "system.audit"],
  support: ["user.view", "order.view"],
}

export type AuditAction = "改套餐" | "调积分" | "退款" | "封禁" | "解封" | "改积分口径"

export interface AuditLog {
  id: string
  operator: string
  role: RoleKey
  action: AuditAction
  target: string
  detail: string
  result: "成功" | "失败"
  at: string
}

export const auditLogs: AuditLog[] = [
  { id: "AL5001", operator: "林晚舟", role: "ops", action: "调积分", target: "U100237 张文涛", detail: "手动补偿 +500，原因：生成失败补偿", result: "成功", at: "2026-06-25 10:12" },
  { id: "AL5002", operator: "沈知行", role: "finance", action: "退款", target: "ORD-20260623-0049", detail: "退款 ¥49，原因：用户重复下单", result: "成功", at: "2026-06-23 15:02" },
  { id: "AL5003", operator: "顾屿安", role: "superadmin", action: "改积分口径", target: "长篇生成", detail: "1500 → 1500（确认无变更）", result: "成功", at: "2026-06-22 11:40" },
  { id: "AL5004", operator: "林晚舟", role: "ops", action: "封禁", target: "U102119 孙倩", detail: "原因：异常批量调用 API", result: "成功", at: "2026-06-21 20:30" },
  { id: "AL5005", operator: "顾屿安", role: "superadmin", action: "改套餐", target: "专业版", detail: "月度赠送积分 18000 → 20000", result: "成功", at: "2026-06-20 09:30" },
  { id: "AL5006", operator: "陆则铭", role: "ops", action: "调积分", target: "U101205 陈雅芝", detail: "尝试 -100000，超出权限阈值", result: "失败", at: "2026-06-19 16:48" },
  { id: "AL5007", operator: "沈知行", role: "finance", action: "退款", target: "ORD-20260621-0033", detail: "退款发起失败，订单状态为支付失败", result: "失败", at: "2026-06-21 20:15" },
]

// ---------------- 概览看板 ----------------
export const kpis = {
  revenueToday: 18960,
  revenueDeltaPct: 12.4,
  activeUsers: 1284,
  activeDeltaPct: 5.2,
  newSubs: 38,
  renewSubs: 21,
  pointsConsumedToday: 86420,
  pointsDeltaPct: -3.1,
  pendingRefunds: 4,
}

// 近 30 天趋势
function genTrend() {
  const data: { date: string; revenue: number; active: number }[] = []
  const base = new Date("2026-05-27")
  let rev = 12000
  let act = 980
  for (let i = 0; i < 30; i++) {
    const d = new Date(base)
    d.setDate(base.getDate() + i)
    rev += Math.round((Math.sin(i / 3) + Math.random() - 0.3) * 1800)
    act += Math.round((Math.cos(i / 4) + Math.random() - 0.2) * 60)
    rev = Math.max(8000, rev)
    act = Math.max(800, act)
    data.push({
      date: `${d.getMonth() + 1}/${d.getDate()}`,
      revenue: rev,
      active: act,
    })
  }
  return data
}

export const trendData = genTrend()
