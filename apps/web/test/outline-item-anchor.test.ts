/**
 * 标书生成页的子目录定位。
 *
 * 用户反馈：提纲能展开到条目，标书生成只列到章——想给「三、营业执照扫描件」插图，
 * 得自己在整章正文里翻。左栏加上子目录后，点条目要能跳到章内那个小标题处。
 *
 * 这里的真实风险是**做了个假功能**：提纲标签与正文标题对不上时，点了没反应还不报错。
 * 2026-08-08 拿线上 943 个条目实测，直接拿标签匹配只有 84% 能定位——下面的样本全部
 * 取自那批对不上的真实数据（序号不一致、提纲独有的「（附件N格式）」括注）。
 */
import { describe, it, expect } from "bun:test"
import { blockMatchesAnchor, findAnchorBlock, outlineItemAnchor, ITEM_ANCHOR_MIN } from "@/lib/anchor"

describe("outlineItemAnchor", () => {
  it.each([
    ["一、法定代表人证明书（附件2格式）", "法定代表人证明书"],
    ["一、法定代表人授权委托书（附件3格式）", "法定代表人授权委托书"],
    ["一、报价一览表（附件4格式）", "报价一览表"],
    ["一、采购需求偏离表（附件5-1）", "采购需求偏离表"],
    ["1.1 项目重难点分析", "项目重难点分析"],
    ["（三）售后服务方案", "售后服务方案"],
    ["三、营业执照扫描件", "营业执照扫描件"],
  ])("%s → %s", (label, core) => {
    expect(outlineItemAnchor(label)).toBe(core)
  })

  it("没有序号也没有括注的标签原样保留", () => {
    expect(outlineItemAnchor("企业财务报表")).toBe("企业财务报表")
  })

  it("只剩序号的退化标签 → 空锚点，不定位（回落章节顶部，而不是乱跳）", () => {
    expect(outlineItemAnchor("一、")).toBe("")
    expect(outlineItemAnchor("（附件2格式）")).toBe("")
  })
})

describe("条目定位到正文", () => {
  // 线上实测：提纲写「一、」，正文写「二、」，序号对不上
  const blocks = [
    "<h3>一、投标函</h3>",
    "<h3>二、法定代表人证明书</h3>",
    "<p>兹证明……为我单位法定代表人。</p>",
    "<h3>三、法定代表人授权委托书</h3>",
  ]

  it("序号不同也能定位到正确那一段", () => {
    const anchor = outlineItemAnchor("一、法定代表人证明书（附件2格式）")
    expect(findAnchorBlock(blocks, anchor, ITEM_ANCHOR_MIN)).toBe(1)
  })

  it("短标题不该被最小长度挡掉——挡掉就是点了没反应", () => {
    expect(blockMatchesAnchor("<h3>六、企业财务报表</h3>", "企业财务报表", ITEM_ANCHOR_MIN)).toBe(true)
    // 审查锚点仍按原来的 8 字下限，行为不变
    expect(blockMatchesAnchor("<h3>六、企业财务报表</h3>", "企业财务报表")).toBe(false)
  })

  it("正文里压根没有这一节 → 回落章节顶部，不乱跳", () => {
    const anchor = outlineItemAnchor("六、企业财务报表（附件6-4）")
    expect(findAnchorBlock(blocks, anchor, ITEM_ANCHOR_MIN)).toBe(-1)
  })
})
