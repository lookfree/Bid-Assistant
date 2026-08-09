import { describe, expect, test } from "bun:test"
import { artifactKeys, scopeAvailability, volumeStale } from "../lib/export-scope"

describe("scopeAvailability", () => {
  test("未标组章节归商务册(与后端/预算同口径)", () => {
    expect(scopeAvailability([{ group: "tech" }, {}])).toEqual({ full: true, tech: true, business: true })
  })
  test("全 tech 时商务册置灰", () => {
    expect(scopeAvailability([{ group: "tech" }])).toEqual({ full: true, tech: true, business: false })
  })
  test("空提纲全部置灰", () => {
    expect(scopeAvailability([])).toEqual({ full: false, tech: false, business: false })
  })
})

describe("artifactKeys", () => {
  test("全量键名不变(兼容),分册带后缀", () => {
    expect(artifactKeys("full")).toEqual({ docx: "docx", pdf: "pdf", pdfPages: "pdf_pages" })
    expect(artifactKeys("tech").docx).toBe("docx_tech")
    expect(artifactKeys("business").pdf).toBe("pdf_biz")
  })
})

describe("volumeStale（终审 C1：下载区过期判定）", () => {
  test("未产出过该册(hasKey=false)：不适用过期，恒不过期", () => {
    expect(volumeStale(null, "2026-08-09T00:00:00.000Z", false)).toBe(false)
    expect(volumeStale("2026-08-01T00:00:00.000Z", "2026-08-09T00:00:00.000Z", false)).toBe(false)
  })
  test("从未改过内容(contentChangedAt=null)：不适用过期", () => {
    expect(volumeStale(null, null, true)).toBe(false)
    expect(volumeStale("2026-08-01T00:00:00.000Z", null, true)).toBe(false)
  })
  test("键存在但查不到该册导出时刻(exportedAt=null)：保守当过期", () => {
    expect(volumeStale(null, "2026-08-09T00:00:00.000Z", true)).toBe(true)
  })
  test("导出时刻早于内容变更时刻：过期", () => {
    expect(volumeStale("2026-08-01T00:00:00.000Z", "2026-08-09T00:00:00.000Z", true)).toBe(true)
  })
  test("导出时刻晚于内容变更时刻：未过期", () => {
    expect(volumeStale("2026-08-09T01:00:00.000Z", "2026-08-09T00:00:00.000Z", true)).toBe(false)
  })
  test("跨格式仍按数值比较，不按字符串比较（agent 侧 +00:00 偏移 vs 数据库兜底的 Z 后缀）", () => {
    // "789012+00:00" 若按字符串比较会大于 "789Z"（'0' < 'Z'），但数值上二者是同一时刻附近——
    // 用真实早于/晚于的样本验证走的是 Date 数值比较，不是字符串字典序。
    expect(volumeStale("2026-08-01T00:00:00.000000+00:00", "2026-08-09T00:00:00.000Z", true)).toBe(true)
    expect(volumeStale("2026-08-09T01:00:00.000000+00:00", "2026-08-09T00:00:00.000Z", true)).toBe(false)
  })
  test("时间戳解析不出来（NaN）一律按过期处理——NaN < x 恒为 false，裸比较会把坏数据读成'未过期'", () => {
    expect(volumeStale("不是时间戳", "2026-08-09T00:00:00.000Z", true)).toBe(true)
    expect(volumeStale("2026-08-01T00:00:00.000Z", "不是时间戳", true)).toBe(true)
    expect(volumeStale("不是时间戳", "也不是", true)).toBe(true)
  })
})
