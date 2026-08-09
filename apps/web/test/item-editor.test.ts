import { describe, expect, it } from "bun:test"
import { buildEntryInput } from "@/app/(tool)/library/item-editor"
import type { LibraryEntry } from "@/lib/library-api"

// 用户反馈：占位提示"张三 · 项目经理"逼用户把多项信息塞一个框，应该一项一个输入框。
// personnel/performance 类现在有预置字段输入框（职称/从业年限/持有证书/拟任岗位 或
// 业主单位/合同金额/完成时间/项目角色），buildEntryInput 负责把它们序列化进 fields[]；
// 其余类目没有 fields 编辑器，PUT「缺键=不改」契约必须逐字节保持不变（回归覆盖）。

const entry = (p: Partial<LibraryEntry> = {}): LibraryEntry =>
  ({ id: "i1", category: "personnel", title: "张三", createdAt: "", updatedAt: "", ...p }) as LibraryEntry

const form = (p: Partial<{ title: string; meta: string; expiry: string; body: string; tags: string }> = {}) => ({
  title: "", meta: "", expiry: "", body: "", tags: "", ...p,
})

describe("buildEntryInput：人员/业绩预置字段", () => {
  it("新建：填写的预置字段进 fields，空值不存", () => {
    const input = buildEntryInput("personnel", null, form({ title: "张三" }), [], {
      职称: "高级工程师",
      从业年限: "",
      持有证书: "PMP",
      拟任岗位: "",
    })
    expect(input.fields).toEqual([
      { label: "职称", value: "高级工程师" },
      { label: "持有证书", value: "PMP" },
    ])
  })

  it("新建：预置字段全空 → 不带 fields 键（不凭空长出空数组）", () => {
    const input = buildEntryInput("personnel", null, form({ title: "张三" }), [], {})
    expect("fields" in input).toBe(false)
  })

  it("编辑：预置字段之外的历史 fields 原样保留在后面，不因本次改动丢失", () => {
    const item = entry({
      fields: [
        { label: "职称", value: "旧值" },
        { label: "自定义标签", value: "手填过的" },
      ],
    })
    const input = buildEntryInput("personnel", item, form({ title: "张三" }), [], { 职称: "新值" })
    expect(input.fields).toEqual([
      { label: "职称", value: "新值" },
      { label: "自定义标签", value: "手填过的" },
    ])
  })

  it("编辑：预置字段回填后清空、且无历史额外字段 → fields 显式 null（PUT 清空契约）", () => {
    const item = entry({ fields: [{ label: "职称", value: "旧值" }] })
    const input = buildEntryInput("personnel", item, form({ title: "张三" }), [], { 职称: "" })
    expect(input.fields).toBeNull()
  })

  it("performance 同款：预置标签为业主单位/合同金额/完成时间/项目角色", () => {
    const input = buildEntryInput("performance", null, form({ title: "某市政道路改造项目" }), [], {
      业主单位: "某市住建局",
      合同金额: "500万元",
      完成时间: "2024年",
      项目角色: "总承包",
    })
    expect(input.fields).toEqual([
      { label: "业主单位", value: "某市住建局" },
      { label: "合同金额", value: "500万元" },
      { label: "完成时间", value: "2024年" },
      { label: "项目角色", value: "总承包" },
    ])
  })
})

describe("buildEntryInput：其他类目 fields 契约不变（回归）", () => {
  it("新建：不带 fields 键——fields 编辑器仍不适用其他类目", () => {
    const input = buildEntryInput("qualification", null, form({ title: "ISO27001" }), [], { 职称: "不该生效" })
    expect("fields" in input).toBe(false)
  })

  it("编辑：fields 原样回传，预置字段输入不影响其他类目", () => {
    const item = entry({ category: "qualification", fields: [{ label: "认证机构", value: "某认证机构" }] })
    const input = buildEntryInput("qualification", item, form({ title: "ISO27001" }), [], { 职称: "不该生效" })
    expect(input.fields).toEqual([{ label: "认证机构", value: "某认证机构" }])
  })

  it("编辑：条目原本无 fields → 回传 null（与改动前行为一致）", () => {
    const item = entry({ category: "text", fields: undefined })
    const input = buildEntryInput("text", item, form({ title: "公司简介" }), [], {})
    expect(input.fields).toBeNull()
  })
})
