import { describe, it, expect } from "bun:test"
import { toCamel } from "../src/lib/case"

describe("toCamel", () => {
  it("递归转换嵌套对象/数组的 key，值原样", () => {
    const out = toCamel<Record<string, unknown>>({
      is_new: true,
      chapter_title: "x",
      passed_items: [{ clause_ids: [1], tender_ref: "对应：第2章" }],
    })
    expect(out).toEqual({
      isNew: true,
      chapterTitle: "x",
      passedItems: [{ clauseIds: [1], tenderRef: "对应：第2章" }],
    })
  })

  it("标量/null 原样返回", () => {
    expect(toCamel<null>(null)).toBe(null)
    expect(toCamel<string>("a_b")).toBe("a_b") // 值不动，只动 key
  })
})
