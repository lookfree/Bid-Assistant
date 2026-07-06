import type { LucideIcon } from "lucide-react"
import { Award, Briefcase, Users, Wallet, FileText, Presentation } from "lucide-react"

export type LibraryCategoryId =
  | "qualification"
  | "performance"
  | "personnel"
  | "finance"
  | "text"
  | "presentation"

/** 资料库附件：真实文件（上传后拿 fileId，点击经 download-url 下载） */
export type LibraryAttachment = { fileId: string; name: string }

// 可空字段与后端契约一致：后端返回 null 表示"无/已清空"（PUT 缺键=不改、null=清空）。
export type LibraryItem = {
  id: string
  /** 条目主标题 */
  title: string
  /** 副信息（客户/职称/类型等） */
  meta?: string | null
  /** 关键字段：金额、职称、编号等结构化补充 */
  fields?: { label: string; value: string }[] | null
  /** 有效期（仅资质类），ISO 字符串或可读文本 */
  expiry?: string | null
  /** 标签 */
  tags?: string[] | null
  /** 附件（真实文件引用） */
  attachments?: LibraryAttachment[] | null
  /** 常用文本类的正文段落，可一键插入 */
  body?: string | null
}

/** 分类的纯前端展示元信息（标题/说明/图标）；条目数据来自后端 GET /api/library */
export type LibraryCategoryMeta = {
  id: LibraryCategoryId
  title: string
  desc: string
  icon: LucideIcon
}

/** 判断有效期是否临期（90 天内）或已过期 */
export function expiryStatus(expiry?: string | null): "ok" | "soon" | "expired" | null {
  if (!expiry) return null
  const d = new Date(expiry)
  if (Number.isNaN(d.getTime())) return null
  const now = new Date()
  const days = Math.ceil((d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
  if (days < 0) return "expired"
  if (days <= 90) return "soon"
  return "ok"
}

export const libraryCategories: LibraryCategoryMeta[] = [
  {
    id: "qualification",
    title: "企业资质",
    desc: "营业执照、各类认证、安全生产许可、资质等级证书",
    icon: Award,
  },
  {
    id: "performance",
    title: "业绩案例",
    desc: "历史项目合同与验收，支持标签复用",
    icon: Briefcase,
  },
  {
    id: "personnel",
    title: "人员信息",
    desc: "项目经理、技术负责人与团队成员资料",
    icon: Users,
  },
  {
    id: "finance",
    title: "财务材料",
    desc: "审计报告、纳税与社保证明、银行资信",
    icon: Wallet,
  },
  {
    id: "text",
    title: "常用文本",
    desc: "投标函、承诺函、授权委托书等模板段落，可一键插入",
    icon: FileText,
  },
  {
    id: "presentation",
    title: "演示模板",
    desc: "企业自有 PPT 模板与历史述标 PPT，可复用套版式或参考要点",
    icon: Presentation,
  },
]

/**
 * 资料库「具备项」关键词索引，供终极审核表等模块联动判断。
 * keyword 用于命中审核表检查项文本；是否已具备由真实资料库条目推导（见 libraryMatch）。
 */
export const libraryCapabilities: { keyword: string; label: string }[] = [
  { keyword: "营业执照", label: "营业执照" },
  { keyword: "ISO", label: "ISO 体系认证" },
  { keyword: "安全生产许可", label: "安全生产许可证" },
  { keyword: "类似业绩", label: "类似项目业绩" },
  { keyword: "财务", label: "审计报告" },
  { keyword: "审计", label: "审计报告" },
  { keyword: "社保", label: "社保证明" },
  { keyword: "纳税", label: "纳税证明" },
  { keyword: "授权委托", label: "授权委托书" },
  { keyword: "投标函", label: "投标函模板" },
  { keyword: "承诺函", label: "承诺函模板" },
  { keyword: "银行资信", label: "银行资信证明" },
]

/**
 * 在审核表条目文本中匹配资料库能力，返回 null（无关项）或 { has, label }。
 * has 基于真实资料库条目推导：任一条目 title/tags 包含该项关键词或名称即视为已具备；
 * 资料库为空时全部为未具备（引导去资料库补充）。
 */
export function libraryMatch(
  itemText: string,
  items: Pick<LibraryItem, "title" | "tags">[],
): { has: boolean; label: string } | null {
  for (const cap of libraryCapabilities) {
    if (!itemText.includes(cap.keyword)) continue
    const hit = (text: string) => text.includes(cap.keyword) || text.includes(cap.label)
    const has = items.some((it) => hit(it.title) || (it.tags ?? []).some(hit))
    return { has, label: cap.label }
  }
  return null
}
