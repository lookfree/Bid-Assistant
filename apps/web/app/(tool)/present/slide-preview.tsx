"use client"

import { ListChecks, Presentation } from "lucide-react"
import type { Slide, SlideChart, SlideStyle } from "@/lib/present"

/* ============== 幻灯片预览画布 ============== */

/** 图表预览：网页里用纯 CSS 条形示意（导出的 PPT 里才是真实可编辑图表对象）——预览只需让用户确认
 *  "数据对不对、比例像不像"，不必还原 PPT 的精确外观，也不为此引入图表库。
 *  各类型统一按"横向条形 + 数值"呈现：结构最简单，饼图/柱状/条形/折线都能读懂比例关系。 */
function ChartPreview({ chart, style }: { chart: SlideChart; style: SlideStyle }) {
  const max = Math.max(...chart.series.flatMap((s) => s.values), 1) // 全 0 时避免除零得到 NaN 宽度
  const multi = chart.series.length > 1
  return (
    <div className="mt-4 flex flex-col gap-2">
      {chart.categories.map((cat, ci) => (
        <div key={ci} className="flex items-center gap-2 text-xs">
          <span className="w-20 shrink-0 truncate text-muted-foreground" title={cat}>
            {cat}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {chart.series.map((s, si) => (
              <div key={si} className="flex items-center gap-1.5">
                <div
                  className={`h-2.5 rounded-sm ${si === 0 ? style.bar : "bg-muted-foreground/40"}`}
                  style={{ width: `${Math.max(2, ((s.values[ci] ?? 0) / max) * 100)}%` }}
                />
                <span className="shrink-0 tabular-nums text-muted-foreground">{s.values[ci] ?? 0}</span>
                {multi && <span className="shrink-0 truncate text-[10px] text-muted-foreground/70">{s.name}</span>}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export function SlidePreview({ slide, style }: { slide: Slide; style: SlideStyle }) {
  if (slide.kind === "cover" || slide.kind === "end") {
    return (
      <div className={`flex aspect-video flex-col items-center justify-center rounded-2xl ${style.coverBg} p-8 text-center text-white shadow-lg`}>
        <Presentation className="size-10 opacity-90" />
        <h2 className="mt-4 text-2xl font-bold text-balance">{slide.title}</h2>
        <div className="mt-4 flex flex-col gap-1 text-sm text-white/85">
          {slide.bullets.map((b, i) => (
            <span key={i}>{b}</span>
          ))}
        </div>
      </div>
    )
  }
  // 章节分隔页：满色块 + 居中大标题（对应导出时的整页主色块），与正文页明显区分
  if (slide.kind === "section") {
    return (
      <div className={`flex aspect-video flex-col items-center justify-center rounded-2xl ${style.coverBg} p-8 text-center text-white shadow-lg`}>
        <h2 className="text-2xl font-bold text-balance">{slide.title}</h2>
        {slide.bullets[0] && <p className="mt-3 text-sm text-white/85">{slide.bullets[0]}</p>}
      </div>
    )
  }
  const isChart = slide.layout === "chart" && !!slide.chart
  const isComparison = slide.layout === "comparison" && (slide.stats?.length ?? 0) > 0
  return (
    <div className="aspect-video overflow-hidden rounded-2xl border border-border bg-card p-7 shadow-lg">
      {slide.scoring && (
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${style.chip}`}>
          <ListChecks className="size-3" />
          {slide.scoring}
        </span>
      )}
      <div className="mt-3 flex items-center gap-2.5">
        <span className={`h-6 w-1 rounded-full ${style.bar}`} />
        <h2 className="text-xl font-bold text-foreground text-balance">{slide.title}</h2>
      </div>

      {isChart ? (
        <>
          <ChartPreview chart={slide.chart!} style={style} />
          {slide.bullets[0] && <p className="mt-3 text-xs text-muted-foreground">{slide.bullets[0]}</p>}
        </>
      ) : isComparison ? (
        <div className="mt-4 grid grid-cols-[1.4fr_1fr] gap-4">
          <ul className="flex flex-col gap-2">
            {slide.bullets.map((b, i) => (
              <li key={i} className="flex items-start gap-2 text-xs leading-relaxed text-foreground">
                <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${style.dot}`} />
                {b}
              </li>
            ))}
          </ul>
          <div className="flex flex-col gap-2">
            {(slide.stats ?? []).map((item, i) => (
              <div key={i} className="rounded-xl border border-border bg-muted/40 px-3 py-2 text-center">
                <p className="text-lg font-bold text-foreground">{item.value}</p>
                <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{item.label}</p>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <ul className="mt-5 flex flex-col gap-2.5">
          {slide.bullets.map((b, i) => (
            <li key={i} className="flex items-start gap-2.5 text-sm leading-relaxed text-foreground">
              <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${style.dot}`} />
              {b}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
