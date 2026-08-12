import { describe, it, expect } from "bun:test"
import { COMPANY_PRESET, COMPANY_TITLE_RE, hasCompanyProfile } from "@/lib/company-profile"

describe("企业信息条目判定", () => {
  it("认得出几种常见叫法", () => {
    for (const t of ["企业信息", "公司信息", "单位信息", "投标人信息", "企业基本信息", "我司企业信息（2026）"]) {
      expect(COMPANY_TITLE_RE.test(t)).toBe(true)
    }
  })

  it("普通常用文本不会被当成企业信息", () => {
    // 常用文本里还放着技术方案片段、售后承诺模板等，误判会让引导卡消失、用户永远不知道该建
    for (const t of ["技术方案常用段落", "售后服务承诺模板", "项目信息表"]) {
      expect(COMPANY_TITLE_RE.test(t)).toBe(false)
    }
  })

  it("「企业信息化」「企业信息安全」这类长文不算——它们是本产品客户的常客", () => {
    // 安全/IT 集成商的常用文本里常年躺着这种标题。误判是双向静默错误：这边不再提示去建真的
    // 那条，后端把方案正文按「标签：值」解析出垃圾字段塞进每个表单章（评审 2026-08-12）。
    for (const t of ["企业信息化建设方案", "企业信息安全管理制度", "公司信息化规划（2026）"]) {
      expect(COMPANY_TITLE_RE.test(t)).toBe(false)
    }
  })

  it("建过就不再打扰", () => {
    expect(hasCompanyProfile([{ title: "技术方案常用段落" }, { title: "企业信息" }])).toBe(true)
    expect(hasCompanyProfile([{ title: "技术方案常用段落" }])).toBe(false)
    expect(hasCompanyProfile([])).toBe(false)
  })

  it("预填骨架的标题命中判据——否则用户照着建完，引导卡还在，后端也不下发", () => {
    expect(COMPANY_TITLE_RE.test(COMPANY_PRESET.title)).toBe(true)
  })

  it("与 App API 的判据**判得一样**——两端各存一份，靠人记得同步就是迟早会漂", async () => {
    // 漂了的表现是**静默**的：前端说「建好了」不再提示，后端却认不出这条、一个字都不下发。
    // 比行为不比字面：.source 会被打包器转义成 \uXXXX，字面比对只会得到一条恒假的假守护。
    const api = await Bun.file(new URL("../../api/src/services/credentials.ts", import.meta.url)).text()
    const source = /COMPANY_TITLE_RE = \/(.+?)\//.exec(api)?.[1]
    expect(source).toBeTruthy()   // 对面改了变量名/写法 → 这条先红，而不是静默失守
    const theirs = new RegExp(source!)
    for (const t of ["企业信息", "公司信息", "单位信息", "投标人信息", "企业基本信息", "公司基本信息",
                     "我司企业信息（2026）", "技术方案常用段落", "售后服务承诺模板", "项目信息表", ""]) {
      expect(theirs.test(t)).toBe(COMPANY_TITLE_RE.test(t))
    }
  })

  it("预填骨架的每一行都是 agent 认得的「标签：值」形状", () => {
    for (const line of COMPANY_PRESET.body.split("\n")) {
      expect(line).toMatch(/^[^：]{2,12}：$/)
    }
  })
})
