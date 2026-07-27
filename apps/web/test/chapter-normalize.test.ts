import { describe, expect, test } from "bun:test"
import { normalizeChapterHtml } from "@/lib/chapter-normalize"

// 与 agent 侧 render/sanitize.py 的 normalize_chapter_html 同一套规则（改语义须两侧同步）
describe("normalizeChapterHtml", () => {
  test("剥内嵌旧章标题并按当前章号改写层级编号", () => {
    const body =
      "<h1>第一章 变更申请基本信息</h1><h2>1.1 项目名称与申请单号</h2><h3>1.1.1 项目名称</h3><p>正文</p>"
    const out = normalizeChapterHtml(body, "第七章", "变更申请基本信息")
    expect(out).not.toContain("<h1>")
    expect(out).toContain("<h2>7.1 项目名称与申请单号</h2>")
    expect(out).toContain("<h3>7.1.1 项目名称</h3>")
  })
  test("旧标题文字已过期（用户改过标题）也按结构剥掉", () => {
    const body = "<h2>2 变更实施计划</h2><h3>2.1 变更目标</h3>"
    const out = normalizeChapterHtml(body, "第二章", "人员配置与职责声明")
    expect(out).not.toContain("变更实施计划")
    expect(out).toContain("<h3>2.1 变更目标</h3>")
  })
  test("首个 h3 子项标题保留并改编号", () => {
    const body = "<h3>7.1 生产组织供应能力分析表</h3><table><tr><td>x</td></tr></table>"
    expect(normalizeChapterHtml(body, "第九章", "生产组织供应能力分析表")).toContain(
      "<h3>9.1 生产组织供应能力分析表</h3>",
    )
  })
  test("同级并列小节不剥；无编号首标题保留；幂等；空值透传", () => {
    const flat = "<h2>一、概述</h2><p>a</p><h2>二、实施</h2><p>b</p>"
    expect(normalizeChapterHtml(flat, "第三章", "施工方案")).toBe(flat)
    const plain = "<h2>概述</h2><p>正文</p>"
    expect(normalizeChapterHtml(plain, "第一章", "整体服务方案")).toBe(plain)
    const once = normalizeChapterHtml("<h1>第一章 整体服务方案</h1><h2>1.1 方案</h2>", "第六章", "整体服务方案")
    expect(normalizeChapterHtml(once, "第六章", "整体服务方案")).toBe(once)
    expect(normalizeChapterHtml("", "第一章", "x")).toBe("")
  })
  test("章号解析不出数字时编号不动，仍剥重复标题", () => {
    const out = normalizeChapterHtml("<h2>第一章 资质文件</h2><h3>1.1 营业执照</h3>", "附录A", "资质文件")
    expect(out).not.toContain("第一章 资质文件")
    expect(out).toContain("<h3>1.1 营业执照</h3>")
  })
})

// ---- 审查修正回归（F1/F2/F3/F4：剥除/改编号启发式的误伤模式，与 Python 侧同步） ----
describe("normalizeChapterHtml 误伤防护", () => {
  test("裸编号多小节体不剥不改（首节有同级兄弟；首段不唯一）", () => {
    const body = "<h2>1 概述</h2><h3>1.1 背景</h3><p>x</p><h2>2 实施</h2><h3>2.1 步骤</h3>"
    expect(normalizeChapterHtml(body, "第三章", "施工方案")).toBe(body)
  })
  test("子项标题含章标题词不剥（N.M 保护 + 相等判定）", () => {
    const body = "<h2>7.1 售后服务体系</h2><p>x</p>"
    expect(normalizeChapterHtml(body, "第七章", "售后服务")).toContain("售后服务体系")
    const body2 = "<h2>售后服务方案</h2><p>x</p>"
    expect(normalizeChapterHtml(body2, "第七章", "售后服务")).toBe(body2)
  })
  test("相邻子项标题不被逐遍蚕食", () => {
    const body = "<h2>7.1 售后服务体系</h2><h2>7.2 售后服务流程</h2><p>x</p>"
    const once = normalizeChapterHtml(body, "第七章", "售后服务")
    expect(once).toBe(body)
    expect(normalizeChapterHtml(once, "第七章", "售后服务")).toBe(once)
  })
  test("层级编号首段不唯一/存在裸编号小节时整章不改编号", () => {
    const mixed = "<h2>1.1 a</h2><h2>2.1 b</h2>"
    expect(normalizeChapterHtml(mixed, "第七章", "某章")).toBe(mixed)
    const bare = "<h3>2.1 步骤</h3><p>x</p><h2>2 实施</h2>"
    expect(normalizeChapterHtml(bare, "第三章", "施工方案")).toBe(bare)
  })
})
