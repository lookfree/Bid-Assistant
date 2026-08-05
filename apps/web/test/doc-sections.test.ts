import { describe, expect, it, test } from "bun:test"
import { clauseLocationIn, groupDocSections, searchDocSections, splitByQuery } from "../lib/doc-sections"
import type { DocSectionGroup } from "../lib/doc-sections"

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
      level: 1,   // 无解析标题时层级一律 1，不装作有结构
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
    expect(groups).toEqual([
      { id: "sec-intro", title: "sec-intro", level: 1, paragraphs: [{ id: "sec-intro", text: "x" }] },
    ])
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

// 章节标题（2026-08-01）：解析器原来把标题行整行丢掉，左栏只能显示硬造的「第N部分」——
// 与文档里真正的章节名毫无关系。现在标题与 clauses 并列保留，按层级渲染。
describe("groupDocSections：真实章节标题", () => {
  const sents = [
    { id: "sec-1-c1", text: "投标人须为独立法人" },
    { id: "sec-2-c1", text: "技术参数应逐条响应" },
  ]

  it("有解析出的标题就用原文标题，并带上层级", () => {
    const out = groupDocSections(sents, [
      { sec: "sec-1", title: "第一章 投标人须知", level: 1 },
      { sec: "sec-2", title: "一、技术要求", level: 2 },
    ])
    expect(out.map((g) => g.title)).toEqual(["第一章 投标人须知", "一、技术要求"])
    expect(out.map((g) => g.level)).toEqual([1, 2])
  })

  it("拿不到标题（老结果/未识别章节）回落「第N部分」，层级一律 1——不装作有结构", () => {
    const out = groupDocSections(sents)
    expect(out.map((g) => g.title)).toEqual(["第1部分", "第2部分"])
    expect(out.every((g) => g.level === 1)).toBe(true)
  })

  it("只有部分节有标题时，其余节仍回落占位，不会串到别的节上", () => {
    const out = groupDocSections(sents, [{ sec: "sec-2", title: "二、商务条款", level: 2 }])
    expect(out.map((g) => g.title)).toEqual(["第1部分", "二、商务条款"])
  })
})

// 原文搜索（提纲页左栏）：大纲条目自带的条款定位不准时，用户要能自己在原文里搜。
describe("searchDocSections", () => {
  const secs: DocSectionGroup[] = [
    {
      id: "sec-1", title: "第一章 投标须知", level: 1,
      paragraphs: [
        { id: "sec-1-c1", text: "3.6.2 投标人不得递交备选投标方案。" },
        { id: "sec-1-c2", text: "投标保证金为人民币两万元整。" },
      ],
    },
    {
      id: "sec-2", title: "第二章 投标保证金", level: 1,
      paragraphs: [{ id: "sec-2-c1", text: "保证金退还方式见附件。" }],
    },
  ]

  it("按关键词命中条款，按文档顺序返回", () => {
    expect(searchDocSections(secs, "保证金").map((m) => m.clauseId)).toEqual(["sec-1-c2", "sec-2-c1"])
  })

  it("命中章节标题时定位到该章第一条——用户搜的是章名，总得跳到那一章去", () => {
    expect(searchDocSections(secs, "投标须知").map((m) => m.clauseId)).toEqual(["sec-1-c1"])
  })

  it("条号里的点不能被当成正则通配：搜 3.6.2 不该匹配 3x6y2", () => {
    const withDecoy: DocSectionGroup[] = [
      { id: "sec-9", title: "x", level: 1, paragraphs: [{ id: "sec-9-c1", text: "编号 3x6y2 的条目" }] },
      ...secs,
    ]
    expect(searchDocSections(withDecoy, "3.6.2").map((m) => m.clauseId)).toEqual(["sec-1-c1"])
  })

  it("其它正则元字符同样按字面量处理，不报错也不误匹配", () => {
    const s: DocSectionGroup[] = [
      { id: "sec-1", title: "t", level: 1, paragraphs: [{ id: "sec-1-c1", text: "费用（含税）合计" }] },
    ]
    expect(searchDocSections(s, "（含税）").map((m) => m.clauseId)).toEqual(["sec-1-c1"])
    expect(searchDocSections(s, "*").length).toBe(0)
  })

  it("英文大小写不敏感", () => {
    const s: DocSectionGroup[] = [
      { id: "sec-1", title: "t", level: 1, paragraphs: [{ id: "sec-1-c1", text: "须具备 ISO27001 认证" }] },
    ]
    expect(searchDocSections(s, "iso27001").length).toBe(1)
  })

  it("空串/纯空白不搜索——否则一输入就全文命中，滚动条乱跳", () => {
    expect(searchDocSections(secs, "")).toEqual([])
    expect(searchDocSections(secs, "   ")).toEqual([])
  })

  it("命中的分组 id 一并带回，供切文件页签用", () => {
    expect(searchDocSections(secs, "保证金")[0]!.secId).toBe("sec-1")
  })
})

describe("splitByQuery", () => {
  it("切成交替的片段，命中片保留原文大小写", () => {
    expect(splitByQuery("须具备 ISO27001 认证", "iso27001")).toEqual([
      { text: "须具备 ", hit: false },
      { text: "ISO27001", hit: true },
      { text: " 认证", hit: false },
    ])
  })

  it("一段里多次命中都要标出来", () => {
    expect(splitByQuery("保证金与保证金退还", "保证金").filter((p) => p.hit).length).toBe(2)
  })

  it("空查询原样返回整段，不做切分", () => {
    expect(splitByQuery("原文", "")).toEqual([{ text: "原文", hit: false }])
  })
})
