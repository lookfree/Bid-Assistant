import { describe, it, expect } from "bun:test"
import { locateFinding, type BidChapter } from "@/lib/bid-chapters"

const CHAPTERS: BidChapter[] = [
  { sec: "sec-1", title: "第一章 商务响应", paragraphs: ["投标函", "我方接受招标文件全部条款。", "报价有效期 90 天。"] },
  { sec: "sec-2", title: "第二章 技术方案", paragraphs: ["总体架构", "零信任网关采用双机热备部署。", "吞吐量实测 12Gbps。"] },
  { sec: "sec-3", title: "第三章 资格证明", paragraphs: ["营业执照复印件（见附件）"] },
]

describe("定位一条风险", () => {
  it("**优先按 sec 精确命中**——审查契约要求 target_id 原样照抄这个键", () => {
    // 章名有出入时模糊匹配就废了（「第一章 商务响应」vs「商务响应（第一册）」），sec 不会
    expect(locateFinding(CHAPTERS, "sec-2", "商务响应（第一册）", "零信任网关采用双机热备部署")).toEqual({
      chapterIndex: 1,
      paragraphIndex: 1,
    })
  })

  it("sec 对不上时退回章名", () => {
    expect(locateFinding(CHAPTERS, "s99", "第三章 资格证明", "")).toEqual({ chapterIndex: 2, paragraphIndex: 0 })
  })

  it("sec 与章名都对不上时，靠摘抄段全书找", () => {
    expect(locateFinding(CHAPTERS, "", "技术分册", "吞吐量实测 12Gbps")).toEqual({
      chapterIndex: 1,
      paragraphIndex: 2,
    })
  })

  it("摘抄段有出入仍落在该段——模型是「原样摘抄」，实际总有出入", () => {
    expect(locateFinding(CHAPTERS, "sec-2", "", "零信任网关采用双机热备")).toEqual({
      chapterIndex: 1,
      paragraphIndex: 1,
    })
  })

  it("章对得上、段落对不上 → 落到该章开头（章是可信的）", () => {
    expect(locateFinding(CHAPTERS, "sec-3", "", "这段标书里根本没有的话")).toEqual({
      chapterIndex: 2,
      paragraphIndex: 0,
    })
  })

  it("三条路都对不上 → null，**绝不落到第一章**", () => {
    // 落第一章会让用户以为问题出在标书开头（同 report-dialog 那个假定位的教训）
    expect(locateFinding(CHAPTERS, "s99", "第九章 不存在", "也不存在的一段话")).toBeNull()
  })

  it("什么定位信息都没有 → null", () => {
    expect(locateFinding(CHAPTERS, "", "", "")).toBeNull()
  })

  it("空标书（解析不出章）→ null，不报错", () => {
    expect(locateFinding([], "sec-2", "第二章 技术方案", "随便")).toBeNull()
  })
})
