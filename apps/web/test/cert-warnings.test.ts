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
    expect(CERT_KEYWORDS).toEqual(["营业执照", "资质证书", "授权书", "法定代表人身份证明", "检测证书", "许可证"])
  })
})
