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

  test("同组多条合并并排序（连续号折叠为区间），标题取首个空白分词", () => {
    expect(clauseLocationIn(sections, ["sec-2-c3", "sec-2-c2"])).toBe("第二章 · 第2-3条")
    expect(clauseLocationIn(sections, ["sec-2-c5", "sec-2-c2"])).toBe("第二章 · 第2/5条") // 不连续保持分列
  })

  test("跨组用分号连接；未知组回落 id", () => {
    expect(clauseLocationIn(sections, ["sec-1-c1", "sec-9-c4"])).toBe("第1部分 · 第1条；sec-9 · 第4条")
  })

  test("连续条号折叠成区间（生产实测：技术需求引用 60+ 条款逐条罗列会挤掉条目标题）", () => {
    const ids = [...Array.from({ length: 58 }, (_, i) => `sec-41-c${i + 1}`),
                 "sec-41-c61", "sec-41-c62", "sec-41-c63", "sec-41-c64", "sec-41-c65",
                 "sec-82-c1"]
    expect(clauseLocationIn(sections, ids)).toBe("sec-41 · 第1-58/61-65条；sec-82 · 第1条")
  })

  test("零散段超过上限截断为「前4段…条（共N处）」", () => {
    const ids = [1, 3, 5, 7, 9, 11, 13].map((n) => `sec-1-c${n}`)
    expect(clauseLocationIn(sections, ids)).toBe("第1部分 · 第1/3/5/7…条（共7处）")
  })

  test("重复条款 id 去重后再折叠", () => {
    expect(clauseLocationIn(sections, ["sec-1-c2", "sec-1-c2", "sec-1-c3"])).toBe("第1部分 · 第2-3条")
  })
})
