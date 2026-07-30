import { describe, expect, it } from "bun:test"
import { presentable, reviewable } from "@/lib/bid-pick"
import type { ProjectListItem } from "@/lib/project"

const p = (o: Partial<ProjectListItem> = {}): ProjectListItem =>
  ({
    id: "p1", name: "项目", status: "running", currentStep: "done",
    stepIndex: 6, totalSteps: 6, createdAt: "2026-07-30", tenderCount: 1, hasBid: true, ...o,
  }) as ProjectListItem

describe("presentable：述标只能选已经有投标文件的项目", () => {
  it("有标书就能选（线下标书任何步都行；生成项目正文写完即可，不必先跑体检）", () => {
    expect(presentable(p({ currentStep: "present" }))).toBe(true)
    expect(presentable(p({ currentStep: "review" }))).toBe(true)  // 正文刚写完，后端闸门已放行
    expect(presentable(p({ kind: "review", currentStep: "read" }))).toBe(true)
  })
  it("没有标书的一律不列——选中只会空转，最坏白跑一次扣积分", () => {
    expect(presentable(p({ hasBid: false, currentStep: "done" }))).toBe(false)
    expect(presentable(p({ hasBid: false, kind: "review", currentStep: "read" }))).toBe(false)

  })
  it("字段缺失（旧缓存/旧后端）时不误杀：只有明确 false 才排除", () => {
    expect(presentable(p({ hasBid: undefined, currentStep: "done" }))).toBe(true)
  })
})

describe("reviewable：招标文件与投标文件是一体的", () => {
  it("两者齐备才可选", () => {
    expect(reviewable(p({ currentStep: "review", tenderCount: 2 }))).toBe(true)
  })
  it("明确没有招标文件时不可选（废标体检要逐条比对招标要求，缺了无从判定）", () => {
    expect(reviewable(p({ currentStep: "review", tenderCount: 0 }))).toBe(false)
  })
  it("字段缺失（web 先于 api 发版/旧缓存）视为未知而放行——整列表空掉比列多了更糟", () => {
    expect(reviewable(p({ currentStep: "review", tenderCount: undefined }))).toBe(true)
    expect(reviewable(p({ currentStep: "review", hasBid: undefined, tenderCount: undefined }))).toBe(true)
  })
  it("缺投标文件不可选；正文还没生成的项目也不列", () => {
    expect(reviewable(p({ hasBid: false }))).toBe(false)
    expect(reviewable(p({ currentStep: "outline" }))).toBe(false)
  })
})
