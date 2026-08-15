/**
 * 提纲的「有没有未保存的修改」判断。
 *
 * 2026-08-07 用户反馈：改过的标题、新增的子项在生成正文后全没了，回到提纲页也没了。
 * 实测线上库里那些子项一条都不在——改动只活在前端 state，而唯一显眼的行动按钮
 * 「确认大纲，生成投标正文」是纯跳转，点下去当场丢且毫无提示。
 *
 * 现在跳转前用 buildOutlinePayload 序列化后与已落盘快照比对，不一致就拦下来提示。
 * 所以这个函数漏掉任何一个字段，都等于「用户改了但我们认为没改」→ 照旧默默丢失。
 * 下面每条都对应一种真实的改法。
 */
import { describe, it, expect } from "bun:test"
import { buildOutlinePayload } from "@/lib/outline-edit"

type Ch = Parameters<typeof buildOutlinePayload>[0][number]

const item = (id: string, label: string, extra: Record<string, unknown> = {}) => ({
  id,
  label,
  desc: "",
  clauseIds: [],
  isNew: false,
  children: [],
  ...extra,
})

const chapter = (over: Partial<Ch> = {}): Ch => ({
  id: "c1",
  no: "第七章",
  title: "资格审查资料",
  sourced: true,
  structureRef: null,
  desc: "",
  items: [item("i1", "一、基本情况表")],
  ...over,
})

const snap = (tech: Ch[], biz: Ch[] = [], bizFirst = false) =>
  JSON.stringify(buildOutlinePayload(tech, biz, bizFirst))

describe("buildOutlinePayload 能认出用户的每一种改动", () => {
  it("没动过 → 快照一致（否则会天天弹「有未保存修改」，提示就废了）", () => {
    expect(snap([chapter()])).toBe(snap([chapter()]))
  })

  it("改章标题", () => {
    expect(snap([chapter({ title: "资格审查资料（包件四）" })])).not.toBe(snap([chapter()]))
  })

  it("改子项标题", () => {
    const edited = chapter({ items: [item("i1", "一、基本情况表（附营业执照）")] })
    expect(snap([edited])).not.toBe(snap([chapter()]))
  })

  it("新增子项", () => {
    const added = chapter({ items: [item("i1", "一、基本情况表"), item("i2", "二、近年财务状况表")] })
    expect(snap([added])).not.toBe(snap([chapter()]))
  })

  it("新增下一级小节——用户反馈里丢的正是这一层", () => {
    const nested = chapter({
      items: [item("i1", "一、基本情况表", { children: [item("i1a", "1.2025年财务报表", { isNew: true })] })],
    })
    expect(snap([nested])).not.toBe(snap([chapter()]))
  })

  it("给子项填了写作说明（它会进正文生成提示词，丢了等于白填）", () => {
    const withDesc = chapter({ items: [item("i1", "一、基本情况表", { desc: "附三年审计报告" })] })
    expect(snap([withDesc])).not.toBe(snap([chapter()]))
  })

  it("给整章填了写作说明——与子项那条是两个字段，只测一个会漏", () => {
    expect(snap([chapter({ desc: "本章按包件四的资格条款逐条对应" })])).not.toBe(snap([chapter()]))
  })

  it("章节重排", () => {
    const a = chapter({ id: "c1", title: "甲" })
    const b = chapter({ id: "c2", title: "乙" })
    expect(snap([a, b])).not.toBe(snap([b, a]))
  })

  it("子项重排", () => {
    const one = chapter({ items: [item("i1", "甲"), item("i2", "乙")] })
    const two = chapter({ items: [item("i2", "乙"), item("i1", "甲")] })
    expect(snap([one])).not.toBe(snap([two]))
  })

  it("改章节编号", () => {
    expect(snap([chapter({ no: "第八章" })])).not.toBe(snap([chapter()]))
  })

  it("切换商务标在前", () => {
    const t = [chapter({ id: "t1", title: "技术" })]
    const b = [chapter({ id: "b1", title: "商务" })]
    expect(snap(t, b, true)).not.toBe(snap(t, b, false))
  })
})

describe("落盘形状", () => {
  it("组别写进每一章（成书顺序按数组顺序，后端据此分技术标/商务标）", () => {
    const out = buildOutlinePayload([chapter({ id: "t1" })], [chapter({ id: "b1" })], true) as Array<{
      id: string
      group: string
    }>
    expect(out.map((c) => [c.id, c.group])).toEqual([
      ["b1", "business"],
      ["t1", "tech"],
    ])
  })

  it("structureRef 缺省落成 null 而不是丢键（spec321 偏离表按它匹配）", () => {
    const [c] = buildOutlinePayload([chapter({ structureRef: undefined })], [], false) as Array<Record<string, unknown>>
    expect(c).toHaveProperty("structureRef", null)
  })

  it("system 章标记透传（丢了这个键=附录被当普通章送模型改写，终审 C1）", () => {
    const [c] = buildOutlinePayload([chapter({ id: "sys-creds", system: true })], [], false) as Array<Record<string, unknown>>
    expect(c).toHaveProperty("system", true)
  })
})

describe("拆章锚透传", () => {
  it("afterId 保存回写透传（丢了它=用户存一次提纲，拆出章丢父绑定——白名单同类教训第四次）", () => {
    const [c] = buildOutlinePayload([chapter({ id: "b1f", afterId: "b1" })], [], false) as Array<
      Record<string, unknown>
    >
    expect(c).toHaveProperty("afterId", "b1")
  })

  it("普通章不带 afterId 键（undefined 序列化自然不落）", () => {
    const [c] = buildOutlinePayload([chapter({ id: "t1" })], [], false) as Array<Record<string, unknown>>
    expect(JSON.parse(JSON.stringify(c))).not.toHaveProperty("afterId")
  })
})

describe("表单章槽位序透传", () => {
  it("formOrder 保存回写透传（白名单剥键暗雷同 afterId）", () => {
    const [c] = buildOutlinePayload([chapter({ id: "b1", formOrder: 2 })], [], false) as Array<
      Record<string, unknown>
    >
    expect(c).toHaveProperty("formOrder", 2)
  })
})
