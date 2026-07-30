import { describe, expect, it } from "bun:test"
import { estimateMinutes, type Slide } from "@/lib/present"

const slide = (o: Partial<Slide> = {}): Slide =>
  ({ id: "s", title: "页", scoring: "", bullets: [], notes: "", kind: "content", ...o }) as Slide

describe("estimateMinutes：图表页/对比页的内容量也要计入", () => {
  // 用多页样本比较：单页时 Math.max(1, …) 的下限会把两侧都压到 1 分钟，分辨不出差异
  const times = <T,>(n: number, make: () => T): T[] => Array.from({ length: n }, make)

  it("图表页的数据点计入密度——否则图表为主的述标会被估成「几乎不用讲」", () => {
    const chartSlide = () =>
      slide({
        layout: "chart",
        chart: { type: "pie", categories: ["高级", "中级", "初级"], series: [{ name: "人数", values: [3, 6, 4] }] },
      })
    // 同一批页数：只看 bullets（空数组）内容量为 0，计入 3 个数据点/页后必须更长
    expect(estimateMinutes(times(8, chartSlide))).toBeGreaterThan(estimateMinutes(times(8, () => slide())))
  })

  it("对比页的数字卡片计入密度", () => {
    const cmp = () =>
      slide({
        layout: "comparison",
        bullets: ["差异点"],
        stats: [{ value: "72 小时", label: "提前完成" }, { value: "0 起", label: "投诉" }],
      })
    const bulletsOnly = () => slide({ bullets: ["差异点"] })
    expect(estimateMinutes(times(8, cmp))).toBeGreaterThan(estimateMinutes(times(8, bulletsOnly)))
  })

  it("至少 1 分钟，且空 deck 不产生 NaN", () => {
    expect(estimateMinutes([])).toBe(1)
    expect(Number.isFinite(estimateMinutes([slide()]))).toBe(true)
  })
})
