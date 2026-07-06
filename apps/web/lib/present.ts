/* -------------------------------------------------------------------------- */
/*  述标演示：幻灯片大纲假数据 + 时长适配 + 模板风格预设                          */
/*  要点与演讲备注由全流程标书 chapters 提炼，项目名取自 projectMeta             */
/*  纯前端演示数据，无后端                                                       */
/* -------------------------------------------------------------------------- */

import { projectMeta } from "./sample-bid"

export type Slide = {
  id: string
  /** 标题 */
  title: string
  /** 对应招标评分点 */
  scoring: string
  /** 要点 bullet */
  bullets: string[]
  /** 演讲备注 / 口播稿 */
  notes: string
  /** 是否封面 / 结束页（不计入讲解时长密度） */
  kind?: "cover" | "end" | "content"
}

/** 述标可能被问到的问题与建议回答 */
export type QA = { q: string; a: string }

export const presentQA: QA[] = [
  {
    q: "你们的技术方案相比其他投标人最大的差异化优势是什么？",
    a: "聚焦招标评分点回答：强调我方在同类项目中已验证的微服务架构与等保三级合规能力，并用 1-2 个量化指标（如响应时间、并发量）佐证，避免空泛承诺。",
  },
  {
    q: "项目经理是否专职？团队人员能否保证到岗？",
    a: "明确项目经理为专职并持 PMP/信息系统项目管理师，社保连续缴纳满足要求；承诺核心成员到岗率，必要时出示社保记录与到岗承诺函。",
  },
  {
    q: "工期较紧，如何保证按时交付？",
    a: "给出里程碑计划与关键路径，说明并行开发、预留缓冲与赶工预案，引用类似项目的按期交付业绩增强说服力。",
  },
  {
    q: "报价中某项明显低于其他投标人，是否存在低价风险？",
    a: "解释成本构成合理、来自规模化复用与自有组件，承诺不以牺牲质量为代价，并提供质保与赔付条款兜底。",
  },
  {
    q: "出现重大故障时的响应与赔付机制是怎样的？",
    a: "给出分级 SLA 响应时间表（如 1 小时响应、4 小时到场）、7×24 值守与赔付条款，呼应技术标中的服务保障章节。",
  },
  {
    q: "如何保证信息安全与数据合规？",
    a: "说明已通过 ISO27001 与等保三级，数据加密、权限分级、审计留痕，并配备应急响应预案，匹配招标的安全合规要求。",
  },
]

/** 主大纲（评分点导向，全量页；要点提炼自标书 chapters） */
const masterSlides: Slide[] = [
  {
    id: "s-cover",
    title: `${projectMeta.name} · 述标演示`,
    scoring: "封面",
    kind: "cover",
    bullets: ["投标人：某信息技术服务有限公司", "述标人：张工 · 项目经理", "日期：2026 年 07 月"],
    notes:
      "各位评委专家上午好！我是本项目投标方的项目经理张工。非常荣幸有机会向各位汇报我方对政务云平台运维服务项目的理解与实施方案。接下来我将用约 X 分钟时间，从项目理解、运维体系、团队、业绩到服务保障逐一汇报，恳请各位评委指正。",
  },
  {
    id: "s-understand",
    title: "项目理解与整体方案",
    scoring: "评分点：项目理解（对应技术标第一章）",
    kind: "content",
    bullets: [
      "准确把握采购人「安全、稳定、高效」三大核心诉求",
      "运维对象覆盖计算/存储/网络/数据库/中间件/云管平台",
      "识别等保 2.0 三级、99.9% 可用性等强制要求",
      "提炼成功关键：可用性、分级响应、数据安全",
    ],
    notes:
      "首先是我方对项目的理解。通过研读招标文件，我们将本项目核心诉求概括为安全、稳定、高效三点。运维对象覆盖政务云平台的计算、存储、网络、数据库、中间件与云管平台，并特别关注等保三级与 99.9% 可用性这两项强制要求——这也是后续方案设计的出发点。",
  },
  {
    id: "s-tech",
    title: "技术实现与运维架构",
    scoring: "评分点：技术方案（对应技术标第二章）",
    kind: "content",
    bullets: [
      "分层解耦运维支撑架构，基础/平台/支撑/安全四层",
      "统一监控 + 自动化运维，分钟级故障发现与自愈",
      "等保 2.0 三级纵深防御，WAF/IDS/堡垒机/日志审计",
      "平台整体可用性承诺 ≥ 99.9%，可审计可追溯",
    ],
    notes:
      "技术方案是评分重点。我方采用分层解耦的运维支撑架构，通过统一监控与自动化运维实现分钟级故障发现和常见故障自愈；安全方面严格落实等保 2.0 三级纵深防御。我们承诺平台整体可用性不低于 99.9%，且全程可审计、可追溯。",
  },
  {
    id: "s-service",
    title: "运维服务体系与 SLA",
    scoring: "评分点：★运维服务体系（20 分）",
    kind: "content",
    bullets: [
      "7×24 小时驻场 + 远程值守，统一服务台闭环",
      "ITSM 五大流程：事件/问题/变更/发布/配置",
      "分级 SLA 响应时间表与未达标赔付条款",
      "月度服务报告 + 季度健康巡检，持续改进",
    ],
    notes:
      "运维服务体系是本项目★不可偏离的核心评分项。我方提供 7×24 驻场加远程值守，以 ITSM 五大流程闭环管理所有服务请求，并以分级 SLA 响应时间表逐级载明响应、到场时间与赔付条款，配套月度报告和季度巡检，保障可用性达标。",
  },
  {
    id: "s-team",
    title: "项目实施团队",
    scoring: "评分点：实施团队（15 分）",
    kind: "content",
    bullets: [
      "项目经理张工，持 PMP 与信息系统项目管理师",
      "安全工程师 2 名，持 CISP，负责等保合规",
      "不少于 8 名驻场，矩阵式组织分专业协作",
      "核心岗位 AB 角，人员稳定性与到岗有保障",
    ],
    notes:
      "团队方面，我方配备专职项目经理张工，持 PMP 和信息系统项目管理师证书；安全工程师 2 名持 CISP，负责等保合规与安全事件处置。驻场人员不少于 8 名，采用矩阵式组织，核心岗位实行 AB 角，保障服务连续性。",
  },
  {
    id: "s-perf",
    title: "应急保障与安全",
    scoring: "评分点：★应急保障与安全（15 分）",
    kind: "content",
    bullets: [
      "识别进度/技术/安全/供应链四类主要风险",
      "重大故障应急预案，分级启动与多方会商",
      "等保 2.0 三级安全防护，全年零重大定级",
      "定期应急演练，复盘归档持续改进",
    ],
    notes:
      "应急保障同样是★评分项。我方识别了进度、技术、安全和供应链四类主要风险，针对重大故障建立分级应急预案；安全上落实等保三级防护并定期组织应急演练，确保问题早发现、早处置。",
  },
  {
    id: "s-price",
    title: "投标报价说明",
    scoring: "评分点：投标报价（30 分）",
    kind: "content",
    bullets: [
      `总报价 1,560 万，低于最高限价 ${projectMeta.budget} 且不低于成本`,
      "价格构成透明：人力/工具平台/备品备件/税金",
      "规模化复用与自有工具平台降低成本",
      "报价唯一且无附加条件，符合实质性响应",
    ],
    notes:
      "报价方面，我方总报价 1560 万，在最高限价 1680 万之内同时不低于成本。价格构成分为人力、工具平台、备品备件和税金四部分，分项合计与总价一致。我方价格优势来自规模化复用和自有工具平台，是合理让利而非恶性低价。",
  },
  {
    id: "s-why",
    title: "为什么选择我们",
    scoring: "评分点：综合实力",
    kind: "content",
    bullets: [
      "同类政务云运维经验丰富，方案经过实战验证",
      "专职团队 + 等保三级能力，合规无短板",
      "价格合理透明，SLA 与赔付有兜底",
      "本地化服务能力强，响应及时",
    ],
    notes:
      "总结一下我方优势：运维经验丰富、方案经过验证；团队专职、安全合规；价格合理、SLA 有兜底；本地化响应及时。我们有信心也有能力高质量完成本项目的运维服务。",
  },
  {
    id: "s-end",
    title: "感谢聆听 · 恳请评委指正",
    scoring: "结束页",
    kind: "end",
    bullets: ["某信息技术服务有限公司", "联系电话：138-XXXX-XXXX"],
    notes:
      "以上就是我方的述标汇报，感谢各位评委的耐心聆听！我和团队随时准备回答各位的提问，恳请各位评委批评指正，谢谢！",
  },
]

/** 20 分钟版额外补充页 */
const extraSlides: Slide[] = [
  {
    id: "s-plan",
    title: "服务进场与过渡计划",
    scoring: "评分点：服务交接合理性",
    kind: "content",
    bullets: [
      "服务期 2 年，划分进场过渡、稳态运维、优化提升三阶段",
      "进场 2 周内完成资产盘点与监控接管",
      "与原运维方平滑交接，零中断过渡",
      "每阶段交付物明确、可考核",
    ],
    notes:
      "我方将 2 年服务期分为进场过渡、稳态运维和优化提升三个阶段。进场两周内完成资产盘点和监控接管，与原运维方平滑交接确保零中断，每个阶段都有明确可考核的交付物，保障服务连续。",
  },
  {
    id: "s-innovation",
    title: "增值服务与持续优化",
    scoring: "评分点：方案创新性（加分项）",
    kind: "content",
    bullets: [
      "引入 AI 运维助手，故障自动诊断与预警",
      "提供运维可视化大屏，辅助领导决策",
      "免费提供一次年度架构优化咨询",
      "开放培训体系，培养采购人自有运维能力",
    ],
    notes:
      "在满足基本要求之外，我方还提供多项增值服务：包括 AI 运维助手、运维可视化大屏、年度架构优化咨询以及运维培训体系，帮助采购人实现可持续的自主运营，这些都是我方的加分亮点。",
  },
]

/**
 * 按时长构建大纲：
 * - 10 分钟：精简 8 页，每页要点 ≤ 3
 * - 15 分钟：完整 10 页，每页要点 ≤ 4
 * - 20 分钟：12 页（含实施计划与创新增值），每页要点全量
 */
export function buildDeck(duration: 10 | 15 | 20): Slide[] {
  if (duration === 10) {
    const keep = new Set([
      "s-cover",
      "s-understand",
      "s-tech",
      "s-team",
      "s-perf",
      "s-service",
      "s-why",
      "s-end",
    ])
    return masterSlides
      .filter((s) => keep.has(s.id))
      .map((s) => ({ ...s, bullets: s.bullets.slice(0, 3) }))
  }
  if (duration === 15) {
    return masterSlides.map((s) => ({ ...s, bullets: s.bullets.slice(0, 4) }))
  }
  // 20 分钟：在风险防控前插入实施计划，结束页前插入创新增值
  const out: Slide[] = []
  for (const s of masterSlides) {
    if (s.id === "s-risk") out.push(extraSlides[0])
    if (s.id === "s-why") out.push(extraSlides[1])
    out.push({ ...s })
  }
  return out
}

/** 预计讲解时长（分钟）：按内容页数与要点密度估算 */
export function estimateMinutes(slides: Slide[]): number {
  const totalBullets = slides.reduce((sum, s) => sum + s.bullets.length, 0)
  const mins = totalBullets * 0.32 + slides.length * 0.35
  return Math.max(1, Math.round(mins))
}

/* -------------------------------------------------------------------------- */
/*  模板风格预设（仅改预览配色，全部为静态类名以便 Tailwind 扫描）               */
/* -------------------------------------------------------------------------- */

export type StyleId = "blue" | "tech" | "gov"

export type SlideStyle = {
  id: string
  name: string
  /** 缩略色块 */
  swatch: string
  /** 封面背景 */
  coverBg: string
  /** 标题强调条 */
  bar: string
  /** 要点圆点 */
  dot: string
  /** 评分点小标签 */
  chip: string
  /** 强调文字 */
  accent: string
}

export const slideStyles: SlideStyle[] = [
  {
    id: "blue",
    name: "商务蓝",
    swatch: "gradient-brand",
    coverBg: "gradient-brand",
    bar: "gradient-brand",
    dot: "bg-primary",
    chip: "bg-primary/10 text-primary",
    accent: "text-primary",
  },
  {
    id: "tech",
    name: "科技感",
    swatch: "bg-slate-900",
    coverBg: "bg-slate-900",
    bar: "bg-cyan-500",
    dot: "bg-cyan-500",
    chip: "bg-cyan-500/10 text-cyan-600",
    accent: "text-cyan-600",
  },
  {
    id: "gov",
    name: "政务红",
    swatch: "bg-red-700",
    coverBg: "bg-red-700",
    bar: "bg-red-600",
    dot: "bg-red-600",
    chip: "bg-red-600/10 text-red-600",
    accent: "text-red-600",
  },
]

/** 企业模板预览配色池（静态类名以便 Tailwind 扫描），按条目 id 稳定哈希循环取用 */
const enterprisePalettes: Omit<SlideStyle, "id" | "name">[] = [
  {
    swatch: "gradient-brand",
    coverBg: "gradient-brand",
    bar: "gradient-brand",
    dot: "bg-primary",
    chip: "bg-primary/10 text-primary",
    accent: "text-primary",
  },
  {
    swatch: "bg-red-700",
    coverBg: "bg-red-700",
    bar: "bg-red-600",
    dot: "bg-red-600",
    chip: "bg-red-600/10 text-red-600",
    accent: "text-red-600",
  },
  {
    swatch: "bg-emerald-600",
    coverBg: "bg-emerald-700",
    bar: "bg-emerald-600",
    dot: "bg-emerald-600",
    chip: "bg-emerald-600/10 text-emerald-700",
    accent: "text-emerald-700",
  },
]

/**
 * 企业自有模板 → 预览配色（演示用）：对资料库条目 id 做稳定哈希，
 * 在配色池中循环取色（同 id 恒同配色），套用后仅切换预览配色/封面占位，
 * 不承诺一键复刻原 PPT 设计。返回 SlideStyle 的 id 绑定条目 id，供选中态判断。
 */
export function enterpriseTemplateStyle(itemId: string, name: string): SlideStyle {
  let h = 0
  for (let i = 0; i < itemId.length; i++) h = (h * 31 + itemId.charCodeAt(i)) >>> 0
  const palette = enterprisePalettes[h % enterprisePalettes.length]
  return { id: `ent-${itemId}`, name, ...palette }
}
