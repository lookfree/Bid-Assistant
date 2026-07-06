import { describe, it, expect } from "bun:test"
import { toCamel, toSnake } from "../src/lib/case"

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

describe("toSnake（toCamel 逆向，编辑回写落库用）", () => {
  it("递归转换嵌套对象/数组的 key，值原样", () => {
    const out = toSnake<Record<string, unknown>>({
      isNew: true,
      chapterTitle: "x",
      passedItems: [{ clauseIds: ["sec-1-c1"], tenderRef: "对应：第2章" }],
    })
    expect(out).toEqual({
      is_new: true,
      chapter_title: "x",
      passed_items: [{ clause_ids: ["sec-1-c1"], tender_ref: "对应：第2章" }],
    })
  })

  it("已是 snake 的 key 幂等（无大写字母原样）", () => {
    const input = { doc_sections: [{ id: "sec-1-c1", text: "条款" }], plain: 1 }
    expect(toSnake<typeof input>(input)).toEqual(input)
  })

  it("与 toCamel 往返：camel → snake → camel 还原", () => {
    const camel = { chapterTitle: "x", items: [{ clauseIds: [1], isNew: false }] }
    expect(toCamel<typeof camel>(toSnake(camel))).toEqual(camel)
  })

  it("标量/null 原样返回，值里的字符串不动", () => {
    expect(toSnake<null>(null)).toBe(null)
    expect(toSnake<Record<string, unknown>>({ aB: "cD" })).toEqual({ a_b: "cD" }) // 值不动，只动 key
  })
})
