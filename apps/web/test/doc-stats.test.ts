import { describe, it, expect } from "bun:test"
import { countChars, estimatePages, fmtChars } from "../lib/doc-stats"

describe("正文体量估算", () => {
  it("countChars：去标签/实体/空白后按字符计", () => {
    expect(countChars("<p>第一章 整体服务方案</p>")).toBe(9)
    expect(countChars("<p>a&nbsp;b</p>\n<p> c </p>")).toBe(3)
    expect(countChars("")).toBe(0)
    expect(countChars("<p><br/></p>")).toBe(0)
  })

  it("estimatePages：按校准密度(515 字/页,192 页实转标定)向上取整，空为 0、非空至少 1", () => {
    expect(estimatePages(0)).toBe(0)
    expect(estimatePages(1)).toBe(1)
    expect(estimatePages(515)).toBe(1)
    expect(estimatePages(516)).toBe(2)
    expect(estimatePages(98_821)).toBe(192) // 校准样本:9.88万字 → LibreOffice 实转 192 页
  })

  it("fmtChars：≥1 万用「N.N万」，其余千分位", () => {
    expect(fmtChars(3200)).toBe("3,200")
    expect(fmtChars(28400)).toBe("2.8万")
  })
})
