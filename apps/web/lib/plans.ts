import type { LucideIcon } from "lucide-react"
import { Gift, Sparkles, Crown } from "lucide-react"

/* -------------------------------------------------------------------------- */
/*  会员档位（积分制 · C 端 3 档）                                              */
/*  免费版 + 个人版 + 专业版，移除团队席位/企业版等 B 端权益                     */
/* -------------------------------------------------------------------------- */

export type TierId = "free" | "personal" | "professional"

export interface Feature {
  text: string
  included: boolean
}

export interface MemberTier {
  id: TierId
  name: string
  tagline: string
  /** 月度赠送积分；免费版为一次性体验额度 */
  credits: number
  priceMonth: number
  priceYear: number
  /** 年付相对 12 个月月付节省的金额 */
  yearSave: number
  icon: LucideIcon
  /** 推荐角标文案 */
  badge?: string
  /** 是否为推荐主推档（视觉放大/阴影） */
  recommended?: boolean
  features: Feature[]
}

/** 顺序即升级路径，索引越大档位越高 */
export const memberTiers: MemberTier[] = [
  {
    id: "free",
    name: "免费版",
    tagline: "注册即送积分，先免费体验再决定",
    credits: 200,
    priceMonth: 0,
    priceYear: 0,
    yearSave: 0,
    icon: Gift,
    features: [
      { text: "注册赠 200 积分（一次性）", included: true },
      { text: "积分可自由用于读标 / 提纲 / 生成 / 导出等任意操作", included: true },
      { text: "完整体验 读标 → 提纲 → 标书生成", included: true },
      { text: "导出 Word / PDF 消耗积分", included: true },
      { text: "废标风险审查 / 标书查重 消耗积分", included: true },
      { text: "积分用尽后可单独充值或开通会员", included: true },
    ],
  },
  {
    id: "personal",
    name: "个人版",
    tagline: "适合低频投标的个人用户，按需用积分",
    credits: 1200,
    priceMonth: 39,
    priceYear: 399,
    yearSave: 69,
    icon: Sparkles,
    features: [
      { text: "每月 1200 积分", included: true },
      { text: "包含免费版全部功能", included: true },
      { text: "导出 Word / PDF（消耗积分）", included: true },
      { text: "废标风险审查（标准）", included: true },
      { text: "标书查重（标准维度）", included: true },
      { text: "积分按需单独充值", included: true },
    ],
  },
  {
    id: "professional",
    name: "专业版",
    tagline: "面向高频标书代写从业者的生产力方案",
    credits: 6000,
    priceMonth: 159,
    priceYear: 1599,
    yearSave: 309,
    icon: Crown,
    badge: "推荐",
    recommended: true,
    features: [
      { text: "每月 6000 积分", included: true },
      { text: "包含个人版全部功能", included: true },
      { text: "逐章重写与一键改写", included: true },
      { text: "标书查重（全维度指纹）", included: true },
      { text: "套用企业 PPT 模板 · 历史述标参考", included: true },
      { text: "优先算力队列，生成更快", included: true },
      { text: "历史项目与版本长期保存", included: true },
    ],
  },
]

/* -------------------------------------------------------------------------- */
/*  积分消耗表（按篇幅 · 字数 · 功能分档）                                       */
/* -------------------------------------------------------------------------- */

export interface CreditCost {
  feature: string
  desc: string
  cost: string
  /** 单次消耗积分数值，供 CreditEstimate 估算使用 */
  value: number
}

export const creditCosts: CreditCost[] = [
  { feature: "招标解读", desc: "识别评分点与关键条款", cost: "20 积分 / 份", value: 20 },
  { feature: "提纲生成", desc: "技术标 + 商务标大纲", cost: "30 积分 / 份", value: 30 },
  { feature: "标书生成（短篇）", desc: "单章 ≤ 2000 字", cost: "40 积分 / 章", value: 40 },
  { feature: "标书生成（长篇）", desc: "单章 > 2000 字", cost: "80 积分 / 章", value: 80 },
  { feature: "逐章重写 / 改写", desc: "针对单章润色重写", cost: "25 积分 / 次", value: 25 },
  { feature: "废标风险审查", desc: "全文风险体检 + 整改建议", cost: "60 积分 / 次", value: 60 },
  { feature: "标书查重", desc: "多维指纹比对", cost: "100 积分 / 次", value: 100 },
  { feature: "述标演示生成", desc: "标书提炼为述标/答辩 PPT", cost: "80 积分 / 次", value: 80 },
  { feature: "导出 Word / PDF", desc: "整本投标文件导出", cost: "20 积分 / 次", value: 20 },
]

/* -------------------------------------------------------------------------- */
/*  单独积分充值包（C 端主力）                                                  */
/*  积分长期有效不过期；单价随包变大而更便宜，对低频用户友好                      */
/* -------------------------------------------------------------------------- */

export interface CreditPack {
  id: string
  credits: number
  price: number
  /** 每 100 积分单价，用于展示性价比 */
  unit: string
  popular?: boolean
}

export const creditPacks: CreditPack[] = [
  { id: "p500", credits: 500, price: 19, unit: "¥3.8 / 100 积分" },
  { id: "p1500", credits: 1500, price: 49, unit: "¥3.3 / 100 积分" },
  { id: "p5000", credits: 5000, price: 139, unit: "¥2.8 / 100 积分", popular: true },
  { id: "p12000", credits: 12000, price: 299, unit: "¥2.5 / 100 积分" },
]
