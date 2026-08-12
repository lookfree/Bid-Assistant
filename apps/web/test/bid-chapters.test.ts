import { describe, it, expect } from "bun:test"
import { locateFinding, paragraphsOf, type BidChapter } from "@/lib/bid-chapters"

const CHAPTERS: BidChapter[] = [
  { title: "第一章 商务响应", text: "投标函\n我方接受招标文件全部条款。\n报价有效期 90 天。" },
  { title: "第二章 技术方案", text: "总体架构\n零信任网关采用双机热备部署。\n吞吐量实测 12Gbps。" },
  { title: "第三章 资格证明", text: "营业执照复印件（见附件）" },
]

describe("切段", () => {
  it("按空行切，去掉空白段", () => {
    expect(paragraphsOf("甲\n\n乙\n  \n丙")).toEqual(["甲", "乙", "丙"])
  })

  it("空正文不报错", () => {
    expect(paragraphsOf("")).toEqual([])
  })
})

describe("定位一条风险", () => {
  it("章标题 + 摘抄段都对得上 → 落到那一段", () => {
    expect(locateFinding(CHAPTERS, "第二章 技术方案", "零信任网关采用双机热备部署")).toEqual({
      chapterIndex: 1,
      paragraphIndex: 1,
    })
  })

  it("摘抄段有出入时仍落在该段——模型是「原样摘抄」，实际总有出入", () => {
    expect(locateFinding(CHAPTERS, "第二章 技术方案", "零信任网关采用双机热备")).toEqual({
      chapterIndex: 1,
      paragraphIndex: 1,
    })
  })

  it("章对得上、段落对不上 → 落到该章开头（章是可信的）", () => {
    expect(locateFinding(CHAPTERS, "第三章 资格证明", "这段标书里根本没有的话")).toEqual({
      chapterIndex: 2,
      paragraphIndex: 0,
    })
  })

  it("章名给的是分册名对不上时，靠摘抄段全书找", () => {
    expect(locateFinding(CHAPTERS, "技术分册", "吞吐量实测 12Gbps")).toEqual({
      chapterIndex: 1,
      paragraphIndex: 2,
    })
  })

  it("章和段都对不上 → null，**绝不落到第一章**", () => {
    // 落第一章会让用户以为问题出在标书开头（同 report-dialog 那个假定位的教训）
    expect(locateFinding(CHAPTERS, "第九章 不存在", "也不存在的一段话")).toBeNull()
  })

  it("没有章名也没有摘抄段 → null", () => {
    expect(locateFinding(CHAPTERS, "", "")).toBeNull()
  })

  it("空标书（解析不出章）→ null，不报错", () => {
    expect(locateFinding([], "第二章 技术方案", "随便")).toBeNull()
  })
})
