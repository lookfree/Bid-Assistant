import { describe, it, expect } from "bun:test"
import { resultShapeOk } from "../src/services/step-result-shape"

/* 生产事故（2026-07-31，项目 8edb7ff2）：present→export 静态边让续跑越界跑了 export，
   export 的产物快照被当成 present 步结果落库、盖住真 deck、还标成 done 净扣 80 积分。
   前端 realDeck.slides 成 undefined → 述标页整页崩。图已改条件边，这里再堵住落库这一关：
   跑出来的东西对不对，App 自己判；不符 = 这一步没成功 → 全额退款。 */

describe("步结果形状守卫", () => {
  it("present 必须有 slides —— 正是那次把 export 产物存进 present 行的形状", () => {
    expect(resultShapeOk("present", { slides: [], qa: [] })).toBe(true)
    expect(resultShapeOk("present", { pdf: "a", docx: "b", pptx: "c", pdfPages: 62 })).toBe(false)
    expect(resultShapeOk("present", { slides: "not-an-array" })).toBe(false)
  })

  it("其它步骤各判自己的主干字段", () => {
    expect(resultShapeOk("outline", { chapters: [] })).toBe(true)
    expect(resultShapeOk("outline", { slides: [] })).toBe(false)
    expect(resultShapeOk("read", { categories: [] })).toBe(true)
    expect(resultShapeOk("read", {})).toBe(false)
    expect(resultShapeOk("export", { docx: "k" })).toBe(true)
    expect(resultShapeOk("export", { pptx: "k" })).toBe(true)
    expect(resultShapeOk("export", { pdfPages: 3 })).toBe(false)
  })

  it("content 的键是模型定的章 id，只要求非空对象 —— 不能按固定字段判", () => {
    expect(resultShapeOk("content", { t1: "<p>正文</p>", b2: "<p>x</p>" })).toBe(true)
    expect(resultShapeOk("content", {})).toBe(false)
  })

  it("null / 非对象 / 数组一律不合格", () => {
    for (const bad of [null, undefined, 42, "x", [1, 2]] as unknown[]) {
      expect(resultShapeOk("present", bad)).toBe(false)
    }
  })

  it("宽进：多几个键、少几个可选键都放行 —— 只有主干字段都没有才判失败", () => {
    expect(resultShapeOk("present", { slides: [{ id: "s" }], 未知键: 1 })).toBe(true)
    expect(resultShapeOk("review", { 任意: 1 })).toBe(true)   // 未列入表的步骤不做形状校验
  })
})
