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

/* 评审 2026-08-17 对整步进度的六条。逐条都是「假进度条」的具体形态，
   这里钉的是纯函数那层能钉的部分；时间插值/单调性由 useOverallProgress 承担，
   其规则以注释形式写在 hook 里并由下面的换算契约支撑。 */
describe("评审 F2-F4：区间来源与优先级", () => {
  it("心跳事件（无区间）→ null，调用方必须沿用上一次带区间的事件，不能当成没区间", () => {
    // 模型流心跳每几秒一条、只有 label；若让它覆盖区间，插值失去依据，整条卡死在起点
    expect(overallPct(phase({ label: "AI 思考中" }))).toBeNull()
  })

  it("解析段 done=0：exact 落在段起点——所以时间插值必须能在它之上继续推进", () => {
    const r = overallPct(phase({ from: 0, to: 35, done: 0, total: 3 }))
    expect(r?.exact).toBe(0)
    expect(r?.ceil).toBe(35)   // hook 按 ceil-1 封顶插值，不会替下一段宣布开始
  })

  it("收尾段（92-100）起点不低于逐章段终点：hook 据此让新段接管，不再听跑完的章级事件", () => {
    const chapterDone = overallPct(phase({ from: 0, to: 92, done: 9, total: 9 }))!
    const finishing = overallPct(phase({ from: 92, to: 100, done: 0, total: 1 }))!
    expect(finishing.base).toBeGreaterThanOrEqual(chapterDone.exact!)
  })
})
