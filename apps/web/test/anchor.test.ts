/**
 * 章内定位锚点匹配。
 *
 * 2026-08-07 用户反馈「点击任何一处都只会定位到第一处高风险章节」。查线上那份报告：
 * 63 条风险只有 16 个不同的定位目标，其中 31 条（49%）都指向同一章「偏离表」，
 * 另有 10 条指向不存在的章节 id。跳转又只滚到章节顶部，所以逐条点过去看着完全一样。
 *
 * 锚点就是为这个而加的。它必须扛住"模型摘抄与正文有出入"——严格相等在富文本里几乎必然失败，
 * 而一旦匹配不上就回落章节顶部，等于这个功能没做。
 */
import { describe, it, expect } from "bun:test"
import { blockMatchesAnchor, findAnchorBlock, normalizeForMatch } from "@/lib/anchor"

describe("blockMatchesAnchor", () => {
  it("原样摘抄的一段能命中", () => {
    expect(blockMatchesAnchor("采购需求偏离表（附件5-1）如下所示", "采购需求偏离表（附件5-1）")).toBe(true)
  })

  it("空白不一致也要命中——富文本会把一个词拆进多个标签", () => {
    expect(blockMatchesAnchor("采购需求  偏离表\n（附件5-1）", "采购需求偏离表（附件5-1）")).toBe(true)
  })

  it("全角/半角括号不一致也要命中", () => {
    expect(blockMatchesAnchor("采购需求偏离表(附件5-1)", "采购需求偏离表（附件5-1）")).toBe(true)
  })

  it("锚点里夹着 HTML 标签也要命中——喂给审查模型的章节本来就是 HTML，摘抄会带上标签", () => {
    expect(blockMatchesAnchor("ISO27001认证证书复印件", "<strong>ISO27001</strong>认证证书复印件")).toBe(true)
  })

  it("无关段落不能命中——错误定位比不定位更糟", () => {
    expect(blockMatchesAnchor("本项目服务期限为一年", "采购需求偏离表（附件5-1）")).toBe(false)
  })

  it("锚点太短就放弃：两三个字会命中一堆无关段落", () => {
    expect(blockMatchesAnchor("响应文件应当密封", "响应")).toBe(false)
  })

  it("空段落/空锚点不命中", () => {
    expect(blockMatchesAnchor("", "采购需求偏离表（附件5-1）")).toBe(false)
    expect(blockMatchesAnchor("采购需求偏离表", "")).toBe(false)
  })
})

describe("findAnchorBlock", () => {
  const blocks = ["第六章 偏离表", "本章列明与采购需求的偏离情况。", "采购需求偏离表（附件5-1）", "商务合同条款偏离表"]

  it("返回锚点所在段的下标", () => {
    expect(findAnchorBlock(blocks, "采购需求偏离表（附件5-1）")).toBe(2)
  })

  it("锚点为空 → -1（回落章节顶部，保持旧行为）", () => {
    expect(findAnchorBlock(blocks, "")).toBe(-1)
    expect(findAnchorBlock(blocks, "   ")).toBe(-1)
  })

  it("找不到 → -1，绝不退而求其次乱指一段", () => {
    expect(findAnchorBlock(blocks, "履约保证金缴纳方式与退还时限")).toBe(-1)
  })

  it("模型末尾多写了几个字：靠前缀兜回来（唯一命中时才算数）", () => {
    const bs = ["项目概述", "硬件令牌要求：令牌自保护防拆"]
    expect(findAnchorBlock(bs, "硬件令牌要求：令牌自保护防拆，令牌拆除自毁，算法支持国密SM3")).toBe(1)
  })

  it("前缀撞上同章套话时宁可不定位——高亮错的一段看着像权威结论，比不定位更糟", () => {
    const bs = [
      "投标人须具备下列资格条件：具有独立承担民事责任的能力",
      "投标人须具备下列资格条件：具有良好的商业信誉和健全的财务会计制度",
    ]
    expect(findAnchorBlock(bs, "投标人须具备下列资格条件：具有依法缴纳社会保障资金的良好记录")).toBe(-1)
  })

  it("整段原样包含时，优先命中它而不是被前面的前缀撞车抢走", () => {
    const bs = [
      "投标人须具备下列资格条件：具有独立承担民事责任的能力",
      "投标人须具备下列资格条件：具有依法缴纳社会保障资金的良好记录",
    ]
    expect(findAnchorBlock(bs, "投标人须具备下列资格条件：具有依法缴纳社会保障资金的良好记录")).toBe(1)
  })
})

describe("normalizeForMatch", () => {
  it("空白与全角标点都被抹平", () => {
    expect(normalizeForMatch("采购 需求（附件5-1）：")).toBe(normalizeForMatch("采购需求(附件5-1):"))
  })
})
