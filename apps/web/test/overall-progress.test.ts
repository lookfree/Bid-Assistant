import { describe, expect, it } from "bun:test"

import { overallPct, type StepPhase } from "../lib/project"

/* 整步进度（2026-08-17 用户口径：100% 是整个任务的）。
   这里钉的是「阶段区间 → 整步百分比」这一层的换算——它决定进度条会不会跳、会不会
   提前走满。时间插值与单调性在 useOverallProgress 里，靠这层的契约才成立。 */

const phase = (p: Partial<StepPhase>): StepPhase => ({ label: "x", ...p })

describe("阶段区间换算成整步百分比", () => {
  it("有真实分母：在自己的区间内按比例定位", () => {
    // 读标提取段 35-85，跑完 3/6 轮 → 35 + 50*0.5 = 60
    expect(overallPct(phase({ from: 35, to: 85, done: 3, total: 6 }))?.exact).toBe(60)
  })

  it("没有真实分母：只给区间，具体位置交给时间插值", () => {
    const r = overallPct(phase({ from: 0, to: 100 }))
    expect(r).toEqual({ base: 0, ceil: 100, exact: null })
  })

  it("没有区间声明（老事件）→ null，调用方回落纯时间估算，绝不自己猜区间", () => {
    expect(overallPct(phase({ done: 1, total: 2 }))).toBeNull()
    expect(overallPct(null)).toBeNull()
  })

  it("区间与比例都夹紧：脏数据不该画出 137% 或负数", () => {
    expect(overallPct(phase({ from: -20, to: 300, done: 99, total: 1 }))?.exact).toBe(100)
    expect(overallPct(phase({ from: 50, to: 20, done: 1, total: 1 }))?.exact).toBe(50) // to<from 视为零宽
  })

  it("正文逐章段封顶 92：收尾（证照就位/填空）要留出自己的区间", () => {
    expect(overallPct(phase({ from: 0, to: 92, done: 10, total: 10 }))?.exact).toBe(92)
  })
})
