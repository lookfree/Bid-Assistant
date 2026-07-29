import { describe, expect, test, it } from "bun:test"
import {
  applyNumbering,
  chapterNo,
  chapterOrdinal,
  deriveNumberMode,
  moveChapter,
  renumberLabel,
  stripNumberPrefix,
  renumberItemsByPosition,
  reorderWithin,
  flattenItems,
  serializeItems,
} from "@/lib/outline-edit"

type Ch = { no: string; items: { label: string }[] }
const ch = (no: string, labels: string[] = []): Ch => ({ no, items: labels.map((label) => ({ label })) })

describe("chapterNo / chapterOrdinal", () => {
  test("双向覆盖 1..21", () => {
    expect(chapterNo(1)).toBe("第一章")
    expect(chapterNo(10)).toBe("第十章")
    expect(chapterNo(12)).toBe("第十二章")
    expect(chapterNo(21)).toBe("第二十一章")
    expect(chapterOrdinal("第一章")).toBe(1)
    expect(chapterOrdinal("第二十一章")).toBe(21)
    expect(chapterOrdinal("第7章")).toBe(7)
    expect(chapterOrdinal("7")).toBe(7)
    expect(chapterOrdinal("附录A")).toBeNull()
  })
})

describe("renumberLabel", () => {
  test("层级编号首段跟随章号", () => {
    expect(renumberLabel("1.1 项目理解", 7)).toBe("7.1 项目理解")
    expect(renumberLabel("2.3.1 细项", 7)).toBe("7.3.1 细项")
  })
  test("无编号/非层级编号不动", () => {
    expect(renumberLabel("项目理解", 7)).toBe("项目理解")
    expect(renumberLabel("3年质保方案", 7)).toBe("3年质保方案")
    expect(renumberLabel("b1.1 投标函", 7)).toBe("b1.1 投标函")
  })
})

describe("applyNumbering", () => {
  test("continuous：按组显示顺序全文连续", () => {
    const groups = [
      [ch("第一章", ["一、商务一"]), ch("第二章", ["一、商务二"])], // 商务标在前
      [ch("第一章", ["一、技术一"])],
    ]
    const [biz, tech] = applyNumbering(groups, "continuous")
    expect(biz!.map((c) => c.no)).toEqual(["第一章", "第二章"])
    expect(tech!.map((c) => c.no)).toEqual(["第三章"])
  })
  test("grouped：各组自起第一章", () => {
    const groups = [[ch("第三章")], [ch("第四章"), ch("第五章")]]
    const [g1, g2] = applyNumbering(groups, "grouped")
    expect(g1!.map((c) => c.no)).toEqual(["第一章"])
    expect(g2!.map((c) => c.no)).toEqual(["第一章", "第二章"])
  })
  test("只改章号，绝不动子项（加一章不该重写另一组手写的小节标题）", () => {
    const groups = [[ch("第九章", ["3.5吨叉车配置方案", "1.1 总体设计"])]]
    const [g] = applyNumbering(groups, "grouped")
    expect(g![0]!.no).toBe("第一章")
    expect(g![0]!.items.map((i) => i.label)).toEqual(["3.5吨叉车配置方案", "1.1 总体设计"])
  })
})

describe("deriveNumberMode", () => {
  test("识别连续/分组/自定义", () => {
    expect(deriveNumberMode([[ch("第一章")], [ch("第二章"), ch("第三章")]])).toBe("continuous")
    expect(deriveNumberMode([[ch("第一章")], [ch("第一章"), ch("第二章")]])).toBe("grouped")
    expect(deriveNumberMode([[ch("第一章")], [ch("附录A"), ch("第二章")]])).toBe("custom")
  })
  test("单组时连续与分组等价，归为 grouped", () => {
    expect(deriveNumberMode([[ch("第一章"), ch("第二章")], []])).toBe("grouped")
  })
})

describe("moveChapter", () => {
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }]
  test("组内上移/下移", () => {
    expect(moveChapter(list, "b", -1).map((c) => c.id)).toEqual(["b", "a", "c"])
    expect(moveChapter(list, "b", 1).map((c) => c.id)).toEqual(["a", "c", "b"])
  })
  test("越界原样返回", () => {
    expect(moveChapter(list, "a", -1).map((c) => c.id)).toEqual(["a", "b", "c"])
    expect(moveChapter(list, "c", 1).map((c) => c.id)).toEqual(["a", "b", "c"])
  })
})

describe("stripNumberPrefix", () => {
  it("剥得掉各种编号形态（含历史点分式），无编号原样返回", () => {
    for (const [raw, bare] of [
      ["一、项目理解", "项目理解"],
      ["1. 项目背景", "项目背景"],
      ["（1）人员配置", "人员配置"],
      ["① 值班安排", "值班安排"],
      ["1.1.2 重点难点", "重点难点"],
      ["第三章 技术方案", "技术方案"],
      ["项目理解", "项目理解"],
      ["3年质保方案", "3年质保方案"], // 「3年」不是编号，不能误剥
    ] as const) {
      expect(stripNumberPrefix(raw)).toBe(bare)
    }
  })

  it("标题里的小数不当编号剥（剥了=数字永久丢失，评审）", () => {
    expect(stripNumberPrefix("3.5吨叉车配置方案")).toBe("3.5吨叉车配置方案")
    expect(stripNumberPrefix("2.5G承载网建设")).toBe("2.5G承载网建设")
    expect(stripNumberPrefix("1.1 项目理解")).toBe("项目理解") // 点分式后接空白仍照剥
  })
})

describe("reorderWithin 同层拖拽重排", () => {
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }]
  it("移到目标之前;null 移到末尾;非法 id/自拖原样", () => {
    expect(reorderWithin(list, "c", "a").map((x) => x.id)).toEqual(["c", "a", "b"])
    expect(reorderWithin(list, "a", "c").map((x) => x.id)).toEqual(["b", "a", "c"])
    expect(reorderWithin(list, "a", null).map((x) => x.id)).toEqual(["b", "c", "a"])
    expect(reorderWithin(list, "a", "a")).toBe(list)
    expect(reorderWithin(list, "x", "a")).toBe(list)
    expect(reorderWithin(list, "a", "x")).toBe(list)
  })
})

describe("renumberItemsByPosition：拖拽/删除后按位置重排（评审二轮 F6）", () => {
  it("各层按位置重排为本层形态（一、/1.）;标题文本保留", () => {
    const items = [
      { label: "1.2 实施方案", children: [{ label: "1.2.3 部署" }, { label: "1.2.1 架构" }] },
      { label: "1.1 总体设计" },
    ]
    const out = renumberItemsByPosition(items)
    expect(out[0]!.label).toBe("一、实施方案")
    expect(out[0]!.children![0]!.label).toBe("1. 部署")
    expect(out[0]!.children![1]!.label).toBe("2. 架构")
    expect(out[1]!.label).toBe("二、总体设计")
  })

  it("四、五级：（1） 与 ①", () => {
    const deep = [{ label: "1. 总体", children: [{ label: "1. 架构", children: [{ label: "1. 人员", children: [{ label: "1. 值班" }] }] }] }]
    const [l2] = renumberItemsByPosition(deep)
    const l3 = l2!.children![0]!
    const l4 = l3.children![0]!
    expect([l2!.label, l3.label, l4.label, l4.children![0]!.label]).toEqual(["一、总体", "1. 架构", "（1）人员", "① 值班"])
  })

  it("无编号项保留原文但子树照常重排（父项没编号不该冻住整条分支）", () => {
    const items = [{ label: "新增子项", children: [{ label: "2. 乙" }, { label: "1. 甲" }] }, { label: "3.9 保障" }]
    const out = renumberItemsByPosition(items)
    expect(out[0]!.label).toBe("新增子项")
    expect(out[0]!.children!.map((c) => c.label)).toEqual(["1. 乙", "2. 甲"])
    expect(out[1]!.label).toBe("二、保障") // 位置序按实际下标:占位跳号
  })
})

describe("flattenItems / serializeItems（评审二轮:迁入可测纯函数层）", () => {
  it("展平含小节;序列化 children 往返不丢", () => {
    const items = [{ id: "a", label: "1.1 x", children: [{ id: "a1", label: "1.1.1 y", clauseIds: ["sec-1-c1"] }] }]
    expect(flattenItems(items).map((i) => i.id)).toEqual(["a", "a1"])
    const ser = serializeItems(items) as Array<{ id: string; children: Array<{ id: string; clauseIds: string[]; children: unknown[] }> }>
    expect(ser[0]!.children[0]!.id).toBe("a1")
    expect(ser[0]!.children[0]!.clauseIds).toEqual(["sec-1-c1"])
    expect(ser[0]!.children[0]!.children).toEqual([])
  })
})
