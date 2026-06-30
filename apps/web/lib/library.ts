import type { LucideIcon } from "lucide-react"
import { Award, Briefcase, Users, Wallet, FileText, Presentation } from "lucide-react"

export type LibraryCategoryId =
  | "qualification"
  | "performance"
  | "personnel"
  | "finance"
  | "text"
  | "presentation"

export type LibraryItem = {
  id: string
  /** 条目主标题 */
  title: string
  /** 副信息（客户/职称/类型等） */
  meta?: string
  /** 关键字段：金额、职称、编号等结构化补充 */
  fields?: { label: string; value: string }[]
  /** 有效期（仅资质类），ISO 字符串或可读文本 */
  expiry?: string
  /** 标签 */
  tags?: string[]
  /** 附件名 */
  attachments?: string[]
  /** 常用文本类的正文段落，可一键插入 */
  body?: string
}

export type LibraryCategory = {
  id: LibraryCategoryId
  title: string
  desc: string
  icon: LucideIcon
  items: LibraryItem[]
}

/** 判断有效期是否临期（90 天内）或已过期 */
export function expiryStatus(expiry?: string): "ok" | "soon" | "expired" | null {
  if (!expiry) return null
  const d = new Date(expiry)
  if (Number.isNaN(d.getTime())) return null
  const now = new Date()
  const days = Math.ceil((d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
  if (days < 0) return "expired"
  if (days <= 90) return "soon"
  return "ok"
}

export const libraryCategories: LibraryCategory[] = [
  {
    id: "qualification",
    title: "企业资质",
    desc: "营业执照、各类认证、安全生产许可、资质等级证书",
    icon: Award,
    items: [
      {
        id: "q1",
        title: "营业执照",
        meta: "统一社会信用代码 91310000XXXXXXXX1A",
        expiry: "2032-06-30",
        attachments: ["营业执照-正本.pdf"],
        tags: ["三证合一"],
      },
      {
        id: "q2",
        title: "ISO27001 信息安全管理体系认证",
        meta: "认证机构：中国质量认证中心（CQC）",
        expiry: "2026-09-15",
        attachments: ["ISO27001证书.pdf"],
        tags: ["信息安全"],
      },
      {
        id: "q3",
        title: "ISO9001 质量管理体系认证",
        meta: "认证范围：软件开发与系统集成",
        expiry: "2026-03-20",
        attachments: ["ISO9001证书.pdf"],
        tags: ["质量体系"],
      },
      {
        id: "q4",
        title: "安全生产许可证",
        meta: "建筑施工类",
        expiry: "2025-12-31",
        attachments: ["安全生产许可证.pdf"],
        tags: ["安全生产"],
      },
      {
        id: "q5",
        title: "信息系统集成及服务资质",
        meta: "等级：二级",
        expiry: "2027-08-01",
        attachments: ["集成资质证书.pdf"],
        tags: ["资质等级"],
      },
    ],
  },
  {
    id: "performance",
    title: "业绩案例",
    desc: "历史项目合同与验收，支持标签复用",
    icon: Briefcase,
    items: [
      {
        id: "p1",
        title: "某市智慧政务云平台建设项目",
        meta: "客户：某市大数据管理局",
        fields: [
          { label: "金额", value: "￥1,280 万" },
          { label: "时间", value: "2023.03 - 2024.01" },
        ],
        attachments: ["合同.pdf", "验收报告.pdf"],
        tags: ["智慧政务", "云平台", "千万级"],
      },
      {
        id: "p2",
        title: "某产业园区智能化弱电工程",
        meta: "客户：某产业发展有限公司",
        fields: [
          { label: "金额", value: "￥860 万" },
          { label: "时间", value: "2022.06 - 2023.02" },
        ],
        attachments: ["合同.pdf", "验收报告.pdf"],
        tags: ["智能化", "弱电"],
      },
      {
        id: "p3",
        title: "某高校智慧校园一期项目",
        meta: "客户：某大学",
        fields: [
          { label: "金额", value: "￥540 万" },
          { label: "时间", value: "2021.09 - 2022.05" },
        ],
        attachments: ["合同.pdf"],
        tags: ["智慧校园", "教育"],
      },
    ],
  },
  {
    id: "personnel",
    title: "人员信息",
    desc: "项目经理、技术负责人与团队成员资料",
    icon: Users,
    items: [
      {
        id: "r1",
        title: "张工 · 项目经理",
        meta: "高级工程师",
        fields: [
          { label: "证书", value: "PMP、信息系统项目管理师" },
          { label: "社保", value: "本单位连续缴纳 36 个月" },
        ],
        attachments: ["身份证.pdf", "PMP证书.pdf", "社保记录.pdf"],
        tags: ["项目经理"],
      },
      {
        id: "r2",
        title: "李工 · 技术负责人",
        meta: "高级工程师",
        fields: [
          { label: "证书", value: "系统架构设计师、网络规划设计师" },
          { label: "社保", value: "本单位连续缴纳 48 个月" },
        ],
        attachments: ["职称证书.pdf", "社保记录.pdf"],
        tags: ["技术负责人"],
      },
    ],
  },
  {
    id: "finance",
    title: "财务材料",
    desc: "审计报告、纳税与社保证明、银行资信",
    icon: Wallet,
    items: [
      {
        id: "f1",
        title: "2023 年度审计报告",
        meta: "事务所：某会计师事务所",
        attachments: ["2023审计报告.pdf"],
        tags: ["审计"],
      },
      {
        id: "f2",
        title: "近半年纳税证明",
        meta: "无重大税收违法记录",
        attachments: ["纳税证明.pdf"],
        tags: ["纳税"],
      },
      {
        id: "f3",
        title: "银行资信证明",
        meta: "授信额度 ￥2,000 万",
        attachments: ["资信证明.pdf"],
        tags: ["银行资信"],
      },
    ],
  },
  {
    id: "text",
    title: "常用文本",
    desc: "投标函、承诺函、授权委托书等模板段落，可一键插入",
    icon: FileText,
    items: [
      {
        id: "t1",
        title: "投标函",
        meta: "标准模板",
        tags: ["函件"],
        body:
          "致：（招标人名称）\n根据贵方（项目名称）的招标文件，遵照《中华人民共和国招标投标法》等规定，我方经审慎研究，决定参加贵方组织的本项目投标。为此，我方郑重承诺如下：……",
      },
      {
        id: "t2",
        title: "法定代表人授权委托书",
        meta: "标准模板",
        tags: ["授权"],
        body:
          "本授权委托书声明：我（姓名）系（投标人名称）的法定代表人，现授权委托（被授权人姓名）为我方代理人。代理人根据授权，以我方名义签署、办理本项目投标的相关事宜，我方均予以承认。……",
      },
      {
        id: "t3",
        title: "廉洁承诺函",
        meta: "标准模板",
        tags: ["承诺"],
        body:
          "我公司参加本项目投标，郑重承诺严格遵守国家有关法律法规，不以任何形式向招标人、评标委员会成员及相关工作人员行贿，自觉维护公平竞争的招标投标秩序。……",
      },
    ],
  },
  {
    id: "presentation",
    title: "演示模板",
    desc: "企业自有 PPT 模板与历史述标 PPT，可复用套版式或参考要点",
    icon: Presentation,
    items: [
      {
        id: "pe1",
        title: "公司标准述标模板.pptx",
        meta: "16:9 · 含封面/母版/配色",
        tags: ["企业模板"],
        attachments: ["公司标准述标模板.pptx"],
      },
      {
        id: "pe2",
        title: "政务项目述标模板.pptx",
        meta: "政务红主题",
        tags: ["企业模板"],
        attachments: ["政务项目述标模板.pptx"],
      },
      {
        id: "pe3",
        title: "2024 智慧园区中标述标.pptx",
        meta: "可参考结构与亮点表达",
        tags: ["历史述标"],
        attachments: ["2024智慧园区中标述标.pptx"],
      },
    ],
  },
]

/**
 * 资料库「具备项」关键词索引，供终极审核表等模块联动判断。
 * key 为审核表检查项中的关键词，value 表示资料库是否已具备。
 */
export const libraryCapabilities: { keyword: string; label: string; has: boolean }[] = [
  { keyword: "营业执照", label: "营业执照", has: true },
  { keyword: "ISO", label: "ISO 体系认证", has: true },
  { keyword: "安全生产许可", label: "安全生产许可证", has: true },
  { keyword: "类似业绩", label: "类似项目业绩", has: true },
  { keyword: "财务", label: "审计报告", has: true },
  { keyword: "审计", label: "审计报告", has: true },
  { keyword: "社保", label: "社保证明", has: true },
  { keyword: "纳税", label: "纳税证明", has: true },
  { keyword: "授权委托", label: "授权委托书", has: true },
  { keyword: "投标函", label: "投标函模板", has: true },
  { keyword: "承诺函", label: "承诺函模板", has: true },
  { keyword: "银行资信", label: "银行资信证明", has: true },
]

/** 在审核表条目文本中匹配资料库能力，返回 true/false/null（无关项） */
export function libraryMatch(itemText: string): { has: boolean; label: string } | null {
  for (const cap of libraryCapabilities) {
    if (itemText.includes(cap.keyword)) return { has: cap.has, label: cap.label }
  }
  return null
}
