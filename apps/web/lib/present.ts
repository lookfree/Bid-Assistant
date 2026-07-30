/* -------------------------------------------------------------------------- */
/*  述标演示：幻灯片/问答数据形状 + 时长估算 + 模板风格预设                        */
/*  幻灯与口播稿由 present 步（agent DeckSpec）真实生成，这里不含任何示例数据      */
/* -------------------------------------------------------------------------- */

/** 图表页数据（layout=chart）：与 agent SlideChart 逐字段对齐（categories 与每个 series.values
 *  长度必须一致，后端 PATCH 与 agent schema 都会校验）。 */
export type SlideChart = {
  type: "column" | "bar" | "pie" | "line"
  categories: string[]
  series: { name: string; values: number[] }[]
}

/** 关键数字卡片（layout=comparison 右栏）：value 是展示用短文本（可带单位，如「7×24」「较限价低 8%」）。 */
export type StatItem = { value: string; label: string }

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
  /** 封面 / 章节分隔页 / 正文 / 结束页（cover/section/end 不计入讲解时长密度） */
  kind?: "cover" | "section" | "end" | "content"
  /** 正文页版式：bullets（默认）/ chart（真实图表对象）/ comparison（左要点+右数字卡片）。
   *  这三个字段必须原样透传回后端——「保存述标」是整份 slides 回写，前端读不到就等于
   *  一次保存把图表页/对比页降级成空白 bullets 页（导出的 PPT 里图表凭空消失）。 */
  layout?: "bullets" | "chart" | "comparison"
  /** comparison 版式右栏数字卡片（1-2 张） */
  stats?: StatItem[]
  /** chart 版式的图表数据 */
  chart?: SlideChart | null
}

/** 述标可能被问到的问题与建议回答 */
export type QA = { q: string; a: string }

/** 预计讲解时长（分钟）：按内容页数与要点密度估算。
 *  图表页/对比页的"内容量"不在 bullets 里（图表数据点、数字卡片才是），一并计入密度——
 *  否则一份图表为主的述标会被估成"几乎不用讲"。 */
export function estimateMinutes(slides: Slide[]): number {
  const totalUnits = slides.reduce((sum, s) => {
    const chartPoints = s.chart ? s.chart.categories.length : 0
    return sum + s.bullets.length + chartPoints + (s.stats?.length ?? 0)
  }, 0)
  const mins = totalUnits * 0.32 + slides.length * 0.35
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
  // 色块对齐 PPT 渲染器实际输出（render/pptx.py 设计令牌），不要用品牌色——品牌是红的，
  // 「商务蓝」曾套 gradient-brand 导致选择器里显示红色（用户实测困惑）。
  {
    id: "blue",
    name: "商务蓝",
    swatch: "bg-blue-800",
    coverBg: "bg-blue-800",
    bar: "bg-blue-600",
    dot: "bg-blue-600",
    chip: "bg-blue-600/10 text-blue-700",
    accent: "text-blue-700",
  },
  {
    id: "tech",
    name: "科技感",
    swatch: "bg-teal-700",
    coverBg: "bg-teal-700",
    bar: "bg-teal-500",
    dot: "bg-teal-500",
    chip: "bg-teal-500/10 text-teal-700",
    accent: "text-teal-700",
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
