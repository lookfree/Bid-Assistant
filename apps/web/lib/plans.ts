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
      { text: "注册即赠体验积分（一次性）", included: true },
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

// 注：积分消耗口径的唯一真相是后端 billing_configs（运营可改），前端一律经 overview.creditCosts /
// creditCostValue(overview, key, fallback) 取实时值。此前这里有一份静态副本，会与后台配置漂移
// （导致"显示 20、实际扣 21"），已删除——切勿再引入静态积分口径表。

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
