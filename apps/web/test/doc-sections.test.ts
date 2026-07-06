import { describe, expect, test } from "bun:test"
import { clauseLocationIn, groupDocSections } from "../lib/doc-sections"

describe("groupDocSections", () => {
  test("按 id 前缀 sec-N 分组并保持组内顺序", () => {
    const groups = groupDocSections([
      { id: "sec-1-c1", text: "a" },
      { id: "sec-1-c2", text: "b" },
      { id: "sec-2-c1", text: "c" },
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0]).toEqual({
      id: "sec-1",
      title: "第1部分",
      paragraphs: [
        { id: "sec-1-c1", text: "a" },
        { id: "sec-1-c2", text: "b" },
      ],
    })
    expect(groups[1].id).toBe("sec-2")
    expect(groups[1].title).toBe("第2部分")
  })

  test("无 -cN 后缀 / 无数字前缀的条目自成一组，标题回落原 id", () => {
    const groups = groupDocSections([{ id: "sec-intro", text: "x" }])
    expect(groups).toEqual([{ id: "sec-intro", title: "sec-intro", paragraphs: [{ id: "sec-intro", text: "x" }] }])
  })
})

describe("clauseLocationIn", () => {
  const sections = [
    { id: "sec-1", title: "第1部分" },
    { id: "sec-2", title: "第二章 投标人资格要求" },
  ]

  test("空/未传 clauseIds 返回空串", () => {
    expect(clauseLocationIn(sections)).toBe("")
    expect(clauseLocationIn(sections, [])).toBe("")
  })

  test("同组多条合并并排序，标题取首个空白分词", () => {
    expect(clauseLocationIn(sections, ["sec-2-c3", "sec-2-c2"])).toBe("第二章 · 第2/3条")
  })

  test("跨组用分号连接；未知组回落 id", () => {
    expect(clauseLocationIn(sections, ["sec-1-c1", "sec-9-c4"])).toBe("第1部分 · 第1条；sec-9 · 第4条")
  })
})
