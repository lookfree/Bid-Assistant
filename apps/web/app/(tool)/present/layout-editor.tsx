"use client"

import { useState } from "react"
import { Plus, X } from "lucide-react"
import type { Slide, SlideChart, StatItem } from "@/lib/present"

/* 述标版式数据编辑（图表页 / 对比页）：这三个字段（layout/chart/stats）不能只做透传——
   「保存述标」是整份 slides 回写，编辑器读不到就等于一次保存把图表页降级成空白页。
   校验口径与 agent SlideChart、App PATCH 的 slideChartSchema 三处对齐：
   categories 与每个 series.values 等长、饼图只能一个 series、stats 1-2 张。 */

const CHART_TYPES: { id: SlideChart["type"]; name: string }[] = [
  { id: "column", name: "柱状图" },
  { id: "bar", name: "条形图" },
  { id: "pie", name: "饼图" },
  { id: "line", name: "折线图" },
]

const inputCls =
  "rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-primary"

/** 类别增删时同步所有 series 的 values 长度——长度一旦不一致，后端 PATCH 与 agent 渲染两处都会拒。 */
function withCategoryCount(chart: SlideChart, next: string[], addedAt?: number): SlideChart {
  return {
    ...chart,
    categories: next,
    series: chart.series.map((s) => {
      if (addedAt === undefined) return { ...s, values: s.values.slice(0, next.length) }
      const values = [...s.values]
      values.splice(addedAt, 0, 0)
      return { ...s, values }
    }),
  }
}

/** 数值单元格：本地保留输入草稿，只在能解析成有限数时才提交。
 *  直接受控绑数字会打不出小数/负数——input[type=number] 在 "12." "-" 这类中间态下 .value 返回
 *  空串，若把空串映射成 0 并立刻回写，用户刚敲的内容会被 React 重渲抹掉（合同额 12.5 输到
 *  小数点就被重置成 0）。values 是 float，小数本来就该支持。失焦时补回合法值，避免留空态。 */
function NumberCell({ value, onCommit }: { value: number; onCommit: (n: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <input
      type="number"
      step="any"
      value={draft ?? String(value)}
      onChange={(e) => {
        const raw = e.target.value
        setDraft(raw)
        const num = Number(raw)
        if (raw !== "" && Number.isFinite(num)) onCommit(num)
      }}
      onBlur={() => setDraft(null)}   // 回到受控值：中间态（空/"-"）不会留在界面上
      className={`w-24 ${inputCls} tabular-nums`}
    />
  )
}

function ChartEditor({ chart, onChange }: { chart: SlideChart; onChange: (c: SlideChart) => void }) {
  const removeCategory = (i: number) => {
    if (chart.categories.length <= 1) return // 至少留一项：categories 空了图表就无法渲染
    onChange({
      ...chart,
      categories: chart.categories.filter((_, idx) => idx !== i),
      series: chart.series.map((s) => ({ ...s, values: s.values.filter((_, idx) => idx !== i) })),
    })
  }
  const addCategory = () => {
    const next = [...chart.categories, "新类别"]
    onChange(withCategoryCount(chart, next, next.length - 1))
  }
  const setValue = (si: number, ci: number, num: number) => {
    onChange({
      ...chart,
      series: chart.series.map((s, i) =>
        i === si ? { ...s, values: s.values.map((v, idx) => (idx === ci ? num : v)) } : s,
      ),
    })
  }
  const setType = (type: SlideChart["type"]) => {
    // 饼图只能一个 series：从多系列切到饼图时只保留第一个，否则保存必被拒
    const series = type === "pie" && chart.series.length > 1 ? [chart.series[0]!] : chart.series
    onChange({ ...chart, type, series })
  }
  const addSeries = () => {
    if (chart.type === "pie") return
    onChange({
      ...chart,
      series: [...chart.series, { name: `系列 ${chart.series.length + 1}`, values: chart.categories.map(() => 0) }],
    })
  }
  const removeSeries = (i: number) => {
    if (chart.series.length <= 1) return
    onChange({ ...chart, series: chart.series.filter((_, idx) => idx !== i) })
  }

  return (
    <div className="mt-4 rounded-xl border border-dashed border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="text-xs font-medium text-muted-foreground">图表数据（导出为可编辑的 PPT 图表）</label>
        <div className="flex items-center gap-1.5">
          <select value={chart.type} onChange={(e) => setType(e.target.value as SlideChart["type"])} className={`${inputCls} py-1`}>
            {CHART_TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {chart.type !== "pie" && (
            <button onClick={addSeries} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
              <Plus className="size-3.5" />
              加系列
            </button>
          )}
        </div>
      </div>

      {/* 系列名（饼图只有一个系列，名字仍可改——它是图例文字） */}
      <div className="mt-3 flex flex-col gap-2">
        {chart.series.map((s, si) => (
          <div key={si} className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-xs text-muted-foreground">系列</span>
            <input
              value={s.name}
              onChange={(e) =>
                onChange({ ...chart, series: chart.series.map((x, i) => (i === si ? { ...x, name: e.target.value } : x)) })
              }
              className={`flex-1 ${inputCls}`}
            />
            {chart.series.length > 1 && (
              <button
                onClick={() => removeSeries(si)}
                className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-destructive"
                aria-label={`删除系列 ${s.name}`}
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>

      {/* 类别 × 各系列数值表格 */}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th className="pb-1 text-left font-medium">类别</th>
              {chart.series.map((s, si) => (
                <th key={si} className="pb-1 pl-2 text-left font-medium">
                  {s.name || `系列 ${si + 1}`}
                </th>
              ))}
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {chart.categories.map((cat, ci) => (
              <tr key={ci}>
                <td className="py-1 pr-2">
                  <input
                    value={cat}
                    onChange={(e) =>
                      onChange({ ...chart, categories: chart.categories.map((c, i) => (i === ci ? e.target.value : c)) })
                    }
                    className={`w-full ${inputCls}`}
                  />
                </td>
                {chart.series.map((s, si) => (
                  <td key={si} className="py-1 pl-2">
                    <NumberCell value={s.values[ci] ?? 0} onCommit={(n) => setValue(si, ci, n)} />
                  </td>
                ))}
                <td className="py-1 pl-2">
                  {chart.categories.length > 1 && (
                    <button
                      onClick={() => removeCategory(ci)}
                      className="rounded p-1 text-muted-foreground transition-colors hover:text-destructive"
                      aria-label={`删除类别 ${cat}`}
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button onClick={addCategory} className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline">
        <Plus className="size-3.5" />
        添加一项
      </button>
    </div>
  )
}

function StatsEditor({ stats, onChange }: { stats: StatItem[]; onChange: (s: StatItem[]) => void }) {
  return (
    <div className="mt-4 rounded-xl border border-dashed border-border p-3">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground">关键数字卡片（右栏，最多 2 张）</label>
        {stats.length < 2 && (
          <button
            onClick={() => onChange([...stats, { value: "", label: "" }])}
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            <Plus className="size-3.5" />
            添加卡片
          </button>
        )}
      </div>
      <div className="mt-2 flex flex-col gap-2">
        {stats.map((item, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              value={item.value}
              placeholder="72 小时"
              onChange={(e) => onChange(stats.map((x, idx) => (idx === i ? { ...x, value: e.target.value } : x)))}
              className={`w-28 shrink-0 ${inputCls} font-medium`}
            />
            <input
              value={item.label}
              placeholder="较招标要求提前完成"
              onChange={(e) => onChange(stats.map((x, idx) => (idx === i ? { ...x, label: e.target.value } : x)))}
              className={`flex-1 ${inputCls}`}
            />
            {stats.length > 1 && (
              <button
                onClick={() => onChange(stats.filter((_, idx) => idx !== i))}
                className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-destructive"
                aria-label="删除卡片"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>
      {stats.length === 0 && (
        <p className="mt-1 text-xs text-destructive">
          对比版式右栏至少要 1 张卡片——现在保存会被拒绝（400），请先添加或把本页版式改回要点。
        </p>
      )}
    </div>
  )
}

/** 按当前页版式渲染对应的数据编辑区；bullets 版式什么都不渲染（要点编辑在外层已有）。 */
export function LayoutDataEditor({ slide, onChange }: { slide: Slide; onChange: (patch: Partial<Slide>) => void }) {
  if (slide.kind !== "content") return null
  if (slide.layout === "chart" && slide.chart) {
    return <ChartEditor chart={slide.chart} onChange={(chart) => onChange({ chart })} />
  }
  if (slide.layout === "comparison") {
    return <StatsEditor stats={slide.stats ?? []} onChange={(stats) => onChange({ stats })} />
  }
  return null
}
