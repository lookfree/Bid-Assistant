import { describe, expect, test } from "bun:test"
import { CERT_KEYWORDS, missingCerts } from "../lib/cert-keywords"

describe("missingCerts", () => {
  test("资格类条目命中词表且资料库无对应条目 → 收进缺证清单", () => {
    const categories = [
      { key: "qualification", items: [{ title: "投标人须提供营业执照复印件" }] },
    ]
    expect(missingCerts(categories, [])).toEqual(["营业执照"])
  })

  test("商务类条目同样计入", () => {
    const categories = [
      { key: "commercial", items: [{ title: "须提供检测证书" }] },
    ]
    expect(missingCerts(categories, [])).toEqual(["检测证书"])
  })

  test("技术类条目命中不计入（技术要求命中证照字样极罕见且易误报）", () => {
    const categories = [
      { key: "technical", items: [{ title: "产品须提供检测证书" }] },
    ]
    expect(missingCerts(categories, [])).toEqual([])
  })

  test("资料库已有同名条目 → 不报（credentialTitles 命中即视为已备）", () => {
    const categories = [
      { key: "qualification", items: [{ title: "须提供营业执照" }] },
    ]
    expect(missingCerts(categories, ["营业执照扫描件"])).toEqual([])
  })

  test("多词命中 → 去重且保持词表序（不按标题出现顺序）", () => {
    const categories = [
      { key: "qualification", items: [{ title: "须提供检测证书" }, { title: "须提供营业执照" }, { title: "另需检测证书复印件" }] },
    ]
    expect(missingCerts(categories, [])).toEqual(["营业执照", "检测证书"])
  })

  test("要求项与资料库都为空 → 空清单", () => {
    expect(missingCerts([], [])).toEqual([])
  })

  test("无命中的普通条目不误报", () => {
    const categories = [
      { key: "qualification", items: [{ title: "投标保证金缴纳方式" }] },
    ]
    expect(missingCerts(categories, [])).toEqual([])
  })

  test("CERT_KEYWORDS 与 agent 侧 cert_placement.py 逐字同形", () => {
    expect(CERT_KEYWORDS).toEqual(["营业执照", "资质证书", "授权书", "法定代表人身份证明", "检测证书", "许可证",
      "审计报告", "资产负债表", "利润表", "财务报表", "纳税证明",
      "社保证明", "银行资信证明", "开户许可证"])
  })

  test("同一份材料的不同说法算同一件事", () => {
    // 招标要求写正式名、用户按习惯命名，两边对不上就等于材料没提供（2026-08-11 用户实测）。
    const categories = [
      { key: "qualification", items: [{ title: "提供法定代表人身份证明" }] },
    ]
    expect(missingCerts(categories, [])).toEqual(["法定代表人身份证明"])
    expect(missingCerts(categories, ["法人身份证"])).toEqual([])   // 库里叫别名也算有
  })

  test("招标那侧用简写同样归得了组", () => {
    const categories = [
      { key: "qualification", items: [{ title: "提供公司执照复印件" }] },
    ]
    expect(missingCerts(categories, [])).toEqual(["营业执照"])
    expect(missingCerts(categories, ["营业执照副本"])).toEqual([])
  })

  test("财务类要求同样出缺证预警", () => {
    // 康恒那单实测：审查报「近三年经审计的资产负债表未提供」，而词表当时只覆盖资质类，
    // 读标阶段一声不吭，用户直到正文生成完才知道缺料。
    const categories = [
      { key: "qualification", items: [{ title: "近三年经审计的资产负债表、损益表" }] },
    ]
    expect(missingCerts(categories, [])).toEqual(["资产负债表"])
    expect(missingCerts(categories, ["2025年度资产负债表"])).toEqual([])
  })

  test("包含关系的两个词只报更具体的那个", () => {
    // 「开户许可证」⊃「许可证」：两个都报会让预警条重复念同一件材料。
    const categories = [
      { key: "qualification", items: [{ title: "基本账户开户许可证" }] },
    ]
    expect(missingCerts(categories, [])).toEqual(["开户许可证"])
  })
})
