import { describe, expect, test } from "bun:test"
import {
  applyNumbering,
  chapterNo,
  chapterOrdinal,
  deriveNumberMode,
  moveChapter,
  renumberLabel,
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
  test("continuous：按组显示顺序全文连续，子项编号跟随", () => {
    const groups = [
      [ch("第一章", ["1.1 商务一"]), ch("第二章", ["2.1 商务二"])], // 商务标在前
      [ch("第一章", ["1.1 技术一"])],
    ]
    const [biz, tech] = applyNumbering(groups, "continuous")
    expect(biz!.map((c) => c.no)).toEqual(["第一章", "第二章"])
    expect(tech!.map((c) => c.no)).toEqual(["第三章"])
    expect(tech![0]!.items[0]!.label).toBe("3.1 技术一")
  })
  test("grouped：各组自起第一章", () => {
    const groups = [[ch("第三章", ["3.1 a"])], [ch("第四章", ["4.1 b"]), ch("第五章", ["5.2 c"])]]
    const [g1, g2] = applyNumbering(groups, "grouped")
    expect(g1!.map((c) => c.no)).toEqual(["第一章"])
    expect(g2!.map((c) => c.no)).toEqual(["第一章", "第二章"])
    expect(g2![1]!.items[0]!.label).toBe("2.2 c")
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
