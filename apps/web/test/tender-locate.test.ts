import { describe, it, expect } from "bun:test"
import { LOCATE_PARAM, locateParamOf, pickLocateTarget, refKeyword, tenderLocateHref } from "@/lib/tender-locate"
import type { DocSectionGroup } from "@/lib/doc-sections"

const SECTIONS: DocSectionGroup[] = [
  {
    id: "sec-1",
    title: "第一章 投标人须知",
    level: 1,
    paragraphs: [
      { id: "sec-1-c1", text: "投标人应按本须知编制响应文件。" },
      { id: "sec-1-c2", text: "投标保证金为人民币贰万元整。" },
    ],
  },
  {
    id: "sec-5",
    title: "第五章 技术规范书",
    level: 1,
    paragraphs: [
      { id: "sec-5-c1", text: "零信任网关吞吐量不低于 10Gbps。" },
      { id: "sec-5-c2", text: "★ 必须支持国密 SM2/SM4 算法。" },
    ],
  },
]

describe("招标出处 → 跳转地址", () => {
  it("正常出处给出带定位词的读标页地址", () => {
    expect(tenderLocateHref("第五章 技术规范书")).toBe(`/read?${LOCATE_PARAM}=${encodeURIComponent("第五章 技术规范书")}`)
  })

  it("空出处不给链接", () => {
    expect(tenderLocateHref("")).toBeNull()
    expect(tenderLocateHref(undefined)).toBeNull()
    expect(tenderLocateHref("   ")).toBeNull()
  })

  it("太短的出处不给链接——「技术」两个字全文到处都是，跳过去是随机落点", () => {
    expect(tenderLocateHref("技术")).toBeNull()
    expect(tenderLocateHref("格式")).toBeNull()
  })

  it("出处里的空格与中文要能安全进 URL", () => {
    const href = tenderLocateHref("第五章 技术规范书")!
    expect(href).not.toContain(" ")
    expect(locateParamOf(href.slice(href.indexOf("?")))).toBe("第五章 技术规范书")
  })

  it("展示串的「对应：」前缀与「（★不可偏离）」后缀要剥掉才能搜得到", () => {
    // 契约要求模型写成「对应：xxx（★不可偏离）」（schemas RiskFinding.tender_ref）。
    // 拿整串去搜必然一条都搜不到——招标原文里只有 xxx，没有「对应：」——
    // 于是「未能定位」横幅会在几乎每条上弹（评审 2026-08-12 实证）。
    expect(refKeyword("对应：第五章 技术规范书（★不可偏离）")).toBe("第五章 技术规范书")
    expect(refKeyword("出处: 投标人须知前附表")).toBe("投标人须知前附表")
    expect(tenderLocateHref("对应：第五章 技术规范书（★不可偏离）"))
      .toBe(`/read?${LOCATE_PARAM}=${encodeURIComponent("第五章 技术规范书")}`)
  })

  it("剥完只剩两个字的出处同样不给链接", () => {
    expect(tenderLocateHref("对应：技术（★不可偏离）")).toBeNull()
  })
})

describe("在招标原文里找落点", () => {
  it("按章节标题命中 → 落到该章第一条", () => {
    expect(pickLocateTarget(SECTIONS, "对应：第五章 技术规范书（★不可偏离）"))
      .toEqual({ clauseId: "sec-5-c1", secId: "sec-5" })
  })

  it("出处是正文里的一句话时，落到那一条本身", () => {
    expect(pickLocateTarget(SECTIONS, "投标保证金")).toEqual({ clauseId: "sec-1-c2", secId: "sec-1" })
  })

  it("**跳过目录行，落到真正的那一章**", () => {
    // 招标 PDF 开头几乎都有目录，把每个章名列一遍。按文档序取第一条会落在目录行上，
    // 高亮给用户看的是一行光秃秃的目录——正是本文件要避免的「假定位」。
    const withToc: DocSectionGroup[] = [
      { id: "sec-0", title: "目录", level: 1, paragraphs: [
        { id: "sec-0-c1", text: "第一章 投标人须知 …… 3" },
        { id: "sec-0-c2", text: "第五章 技术规范书 …… 27" },
      ] },
      ...SECTIONS,
    ]
    expect(pickLocateTarget(withToc, "第五章 技术规范书")?.secId).toBe("sec-5")
  })

  it("找不到就返回 null，**绝不退回第一条**", () => {
    // 退回第一条会让用户以为招标要求写在开头——report-dialog 实测过这个坑（63 条里 10 条假定位）
    expect(pickLocateTarget(SECTIONS, "第九章 不存在的章节")).toBeNull()
  })

  it("空原文（读标还没跑）不报错", () => {
    expect(pickLocateTarget([], "第五章 技术规范书")).toBeNull()
  })

  it("出处含正则元字符不会把定位搞崩", () => {
    // 条号「3.6.2」「（含税）」这类天天出现，不转义会当通配符甚至直接抛异常
    expect(() => pickLocateTarget(SECTIONS, "3.6.2（含税）*")).not.toThrow()
  })
})

describe("从地址栏取定位词", () => {
  it("取得到并去空白", () => {
    expect(locateParamOf(`?${LOCATE_PARAM}=%20%E6%8A%80%E6%9C%AF%E8%A7%84%E8%8C%83%E4%B9%A6%20`)).toBe("技术规范书")
  })

  it("没有该参数时返回空串", () => {
    expect(locateParamOf("?autostart=1")).toBe("")
    expect(locateParamOf("")).toBe("")
  })
})
