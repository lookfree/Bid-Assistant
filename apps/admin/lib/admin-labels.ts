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
  "invoice.write": "开具发票",
  "category.read": "查看标书分类纠偏",
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
  "user.note": "编辑用户备注",
  "invoice.issue": "开具发票",
  "invoice.reject": "驳回开票",
}

/** 审计快照里常见字段名 → 中文（before/after 展开时用；未命中回退原键）。 */
const FIELD_LABELS: Record<string, string> = {
  finance: "财务角色权限",
  ops: "运营角色权限",
  support: "客服角色权限",
  superadmin: "超管角色权限",
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
  passwordReset: "重置密码",
  invoiceNo: "发票号",
  titleType: "抬头类型",
  taxNo: "税号",
  // 各审计动作快照里实际出现的字段（评审实测遗漏）：user.note / admin.manage / refund.write /
  // diff.* / feedback.handle / plan.write 的 before/after 键
  adminNote: "运营备注",
  username: "账号名",
  refundId: "退款单号",
  amountCents: "金额(分)",
  refundStatus: "退款状态",
  orderStatus: "订单状态",
  resolved: "已处理",
  markPaid: "标记为已支付",
  reply: "回复内容",
  error: "错误信息",
  code: "套餐代码",
  name: "名称",
  features: "权益开关",
  limits: "额度限制",
  version: "版本",
  currency: "币种",
  billingCycle: "计费周期",
  createdAt: "创建时间",
  id: "ID",
}

// 对象列（target="类型:id"）：类型前缀中文化,id 保留便于回溯。
const TARGET_PREFIX_CN: Record<string, string> = {
  user: "用户", plan: "套餐", order: "订单", invoice: "发票",
  admin: "管理员账号", feedback: "反馈工单", diff: "对账差异", config: "配置",
}
// config:<key> 的 key 中文名——与 CONFIG_SCHEMAS（apps/api/routes/admin/plans.ts）和各配置卡片同口径。
// 只列全串会漏掉多数配置（评审实测：只覆盖 2/8）,故按冒号后的 key 单独查表,未知 key 保留原样。
const CONFIG_KEY_CN: Record<string, string> = {
  agent_model: "模型编排",
  admin_rbac: "角色权限矩阵",
  referral_rules: "邀请奖励规则",
  recharge_packs: "充值档位",
  signup_grant_credits: "注册赠送积分",
  grant_expire_days: "赠送积分有效期",
  reward_expire_days: "奖励积分有效期",
  "credit_cost.content_tiers": "标书生成计费阶梯",
}
// 用 Object.hasOwn 取值：裸下标会把 constructor/toString 等原型键当命中,返回函数而 : string 类型看不出来
const pick = (m: Record<string, string>, k: string): string | undefined => (Object.hasOwn(m, k) ? m[k] : undefined)

export function targetLabel(t?: string | null): string {
  if (!t) return EMPTY   // 与 fmtVal 同一空值符号,同一弹窗里不能一个「-」一个「—」
  const i = t.indexOf(":")
  if (i <= 0) return t
  const prefix = pick(TARGET_PREFIX_CN, t.slice(0, i))
  if (!prefix) return t
  const rest = t.slice(i + 1)
  if (t.slice(0, i) === "config") return `${prefix}：${pick(CONFIG_KEY_CN, rest) ?? rest}`
  return `${prefix}：${rest}`
}

export const permLabel = (p: string) => PERM_LABELS[p] ?? p
export const actionLabel = (a: string) => ACTION_LABELS[a] ?? a
export const fieldLabel = (k: string) => FIELD_LABELS[k] ?? k

/** 单个快照值 → 展示字符串（null→—；布尔→是/否；对象→JSON；其余 String）。 */
// 权益键中文（QA：审计对照里 features 直出 {"dedupe":false,...} 生 JSON，运营看不懂）。
// 与 plans-client 的 FEATURE_LABELS 同口径；未知键回退原键名（历史配置里可能有已下架的键）。
const FEATURE_CN: Record<string, string> = {
  export: "导出 Word/PDF",
  riskReview: "废标风险审查",
  dedupe: "标书查重",
  rewrite: "逐章重写/一键改写",
  pptTemplate: "企业 PPT 模板",
  fullDedupe: "全维度指纹查重",
  priorityQueue: "优先算力队列",
  longHistory: "历史项目长期保存",
}

/** 全布尔对象（如套餐 features）→ "标书查重:关、导出:开…"；其余对象仍 JSON。 */
function fmtBoolMap(o: Record<string, unknown>): string | null {
  const entries = Object.entries(o)
  if (entries.length === 0 || !entries.every(([, v]) => typeof v === "boolean")) return null
  return entries.map(([k, v]) => `${FEATURE_CN[k] ?? k}:${v ? "开" : "关"}`).join("、")
}

const EMPTY = "—"   // 全审计视图统一的「无值」符号

function fmtVal(v: unknown): string {
  if (v == null) return EMPTY
  if (typeof v === "boolean") return v ? "是" : "否"
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
    // 权限列表等字符串数组：逐项中文化（QA:审计里角色/权限直出英文关键字）,未知项回退原文
    return v.length ? (v as string[]).map((x) => PERM_LABELS[x] ?? x).join("、") : "（无）"
  }
  if (typeof v === "object" && !Array.isArray(v)) {
    const asBoolMap = fmtBoolMap(v as Record<string, unknown>)
    if (asBoolMap) return asBoolMap
    return JSON.stringify(v)
  }
  if (typeof v === "object") return JSON.stringify(v)
  return String(v)
}

/** 审计 before/after → 字段级对照行,替代裸 JSON。合并两侧键（标量快照归到「值」行）,
 *  逐字段给出变更前/后展示值,changed 标记有变化的行（供 UI 高亮前后对照）。 */
export function diffRows(before: unknown, after: unknown): { key: string; label: string; before: string; after: string; changed: boolean }[] {
  // 数组快照（充值档位/计费阶梯等）：键归一成「第 N 项」,否则渲染成 0/1/2 + 裸 JSON（评审实测）
  const toObj = (s: unknown): Record<string, unknown> => {
    if (s == null) return {}
    if (Array.isArray(s)) return Object.fromEntries(s.map((v, i) => [`第 ${i + 1} 项`, v]))
    return typeof s === "object" ? (s as Record<string, unknown>) : { 值: s }
  }
  const b = toObj(before)
  const a = toObj(after)
  const keys = Array.from(new Set([...Object.keys(b), ...Object.keys(a)]))
  // role 字段的值也中文化（QA:审计里角色直出 ops/finance 英文关键字）
  const ROLE_CN: Record<string, string> = { superadmin: "超级管理员", finance: "财务", ops: "运营", support: "客服" }
  const fmt = (k: string, v: unknown): string =>
    k === "role" && typeof v === "string" ? (ROLE_CN[v] ?? v) : fmtVal(v)
  return keys.map((k) => {
    const bv = k in b ? fmt(k, b[k]) : EMPTY
    const av = k in a ? fmt(k, a[k]) : EMPTY
    return { key: k, label: fieldLabel(k), before: bv, after: av, changed: bv !== av }
  })
}

const BILLING_CYCLE_CN: Record<string, string> = { month: "包月", quarter: "包季", year: "包年" }

/** 订单的「套餐 · 周期」展示串。非会员订单（无套餐）回空串——不显示比显示「—」干净。
 *  未知周期只显示套餐名，不猜（库里 cycle_snapshot 由下单时快照，理论上只有三种）。 */
export function orderPlanLabel(o: { planName?: string | null; cycleSnapshot?: string | null }): string {
  if (!o.planName) return ""
  const cycle = o.cycleSnapshot ? BILLING_CYCLE_CN[o.cycleSnapshot] : undefined
  return cycle ? `${o.planName} · ${cycle}` : o.planName
}
