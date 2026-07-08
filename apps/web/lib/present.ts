/* -------------------------------------------------------------------------- */
/*  述标演示：幻灯片/问答数据形状 + 时长估算 + 模板风格预设                        */
/*  幻灯与口播稿由 present 步（agent DeckSpec）真实生成，这里不含任何示例数据      */
/* -------------------------------------------------------------------------- */

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
