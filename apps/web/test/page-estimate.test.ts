import { describe, expect, test } from "bun:test"
import {
  pageCapacity,
  densityForFormat,
  suggestedCharsForPages,
  estimatePagesFromHtml,
  BASE_DENSITY,
} from "@/lib/page-estimate"

// 默认排版（宋体小四 12pt、1.5 倍行距、页边距 2.2/2.3cm）——与 DEFAULT_FORMAT/agent _FMT_DEFAULT 同口径
describe("pageCapacity", () => {
  test("默认排版的版面容量(模型口径固化)", () => {
    const cap = pageCapacity()
    // 可用宽 21-2.3*2=16.4cm≈465pt → 每行 38 个 12pt 汉字；可用高 25.3cm≈717pt / 行高 12*1.3*1.5=23.4pt → 30 行
    expect(cap.charsPerLine).toBe(38)
    expect(cap.linesPerPage).toBe(30)
  })
  test("五号字/固定22磅行距 → 单页容量更大", () => {
    const d = pageCapacity()
    const small = pageCapacity({ body_size: "五号" })
    expect(small.charsPerLine).toBeGreaterThan(d.charsPerLine)
    expect(small.linesPerPage).toBeGreaterThan(d.linesPerPage)
    const fixed = pageCapacity({ line_spacing: "fixed22" })
    expect(fixed.linesPerPage).toBeGreaterThan(d.linesPerPage)
  })
})

describe("densityForFormat / suggestedCharsForPages", () => {
  test("默认排版密度=校准基线,随排版容量等比缩放", () => {
    expect(densityForFormat()).toBe(BASE_DENSITY)
    expect(densityForFormat({ body_size: "五号" })).toBeGreaterThan(BASE_DENSITY)
    expect(densityForFormat({ body_size: "四号" })).toBeLessThan(BASE_DENSITY)
  })
  test("98 页目标 → 约 5 万字(实测密度 515;旧口径 600 给 5.9 万偏高)", () => {
    const chars = suggestedCharsForPages(98)
    expect(chars).toBeGreaterThan(45_000)
    expect(chars).toBeLessThan(55_000)
  })
})

describe("estimatePagesFromHtml", () => {
  const prose = (n: number) => `<p>${"字".repeat(n)}</p>`
  test("空文档为 0;纯散文按版面容量+固定页(封面/目录/签章)", () => {
    expect(estimatePagesFromHtml([], undefined)).toBe(0)
    // 11400 字纯散文 = 10 个满页 + 章标题/固定页零头
    const pages = estimatePagesFromHtml([prose(11_400)], undefined)
    expect(pages).toBeGreaterThanOrEqual(12)
    expect(pages).toBeLessThanOrEqual(14)
  })
  test("表格行按行高计费:同字数下表格远比散文占页(190页实测的主因)", () => {
    const rows = Array.from({ length: 120 }, (_, i) => `<tr><td>条款${i}</td><td>满足</td><td>无偏离</td></tr>`).join("")
    const tableHtml = `<table>${rows}</table>`
    const tableChars = tableHtml.replace(/<[^>]+>/g, "").length // ~1500 字
    const tablePages = estimatePagesFromHtml([tableHtml], undefined)
    const prosePages = estimatePagesFromHtml([prose(tableChars)], undefined)
    expect(tablePages).toBeGreaterThan(prosePages + 2)
  })
  test("标题/图片计费;多章各带章标题成本", () => {
    const withHeads = `<h2>1.1 方案</h2>${"<h3>小节</h3><p>内容内容</p>".repeat(30)}`
    const noHeads = `<p>${"内容".repeat(120)}</p>`
    expect(estimatePagesFromHtml([withHeads], undefined)).toBeGreaterThan(estimatePagesFromHtml([noHeads], undefined))
    const img = `<p>说明</p><img src="data:image/png;base64,x" /><img src="data:image/png;base64,y" />`
    expect(estimatePagesFromHtml([img], undefined)).toBeGreaterThanOrEqual(3)
  })
  test("排版更密 → 页数更少", () => {
    const doc = [prose(20_000)]
    const loose = estimatePagesFromHtml(doc, undefined)
    const dense = estimatePagesFromHtml(doc, { body_size: "五号", line_spacing: 1 })
    expect(dense).toBeLessThan(loose)
  })
})

// ---- 评审修正回归（F2/F3/F9：估 0 页与漏计文本的兜底） ----
describe("estimatePagesFromHtml 覆盖率兜底", () => {
  test("纯图片章不为 0 页(资质扫描件章常见形态)", () => {
    const pages = estimatePagesFromHtml(["<img src='a'/><img src='b'/><img src='c'/>"], undefined, {
      fixedSections: false,
    })
    expect(pages).toBeGreaterThanOrEqual(1)
  })
  test("未闭合标签吞掉的文本按散文补计,不再估成 0", () => {
    const broken = `<p>${"字".repeat(3000)}` // 未闭合,块走查吃不到
    const pages = estimatePagesFromHtml([broken], undefined, { fixedSections: false })
    expect(pages).toBeGreaterThanOrEqual(2)
  })
  test("div 直挂/裸文本也计入", () => {
    const bare = `<div>${"字".repeat(2000)}</div>`
    expect(estimatePagesFromHtml([bare], undefined, { fixedSections: false })).toBeGreaterThanOrEqual(2)
  })
})
