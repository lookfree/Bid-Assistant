import { describe, it, expect } from "bun:test"
import { buildCategories, partialToCategories, readCategories } from "../app/(tool)/read/categories"

const icon = (() => ({}) as never) as (k: string) => never
const cat = (key: string, items: unknown[] = []) => ({ key, title: key, icon: icon(key), items })

describe("读标类目派生", () => {
  it("**分段读标从不产 scoring 类目 → 必须按评分行补齐**，否则大标书的评分点一条都点不到", () => {
    // 实测：876/2014 条款的项目 scoring 有 44/51 行，而 categories keys 里全无 scoring
    const src = ["overview", "qualification", "commercial", "format", "technical"].map((k) => cat(k, [1]))
    const out = buildCategories(src as never, true, icon)
    expect(out.map((c) => c.key)).toContain("scoring")
    // 没有评分行时不该凭空多一个空 tab
    expect(buildCategories(src as never, false, icon).map((c) => c.key)).not.toContain("scoring")
  })

  it("展示顺序固定：分轮并发完成，按到达顺序排会随机开在「技术需求」而不是「项目概况」", () => {
    const out = buildCategories([cat("technical", [1]), cat("overview", [1])] as never, false, icon)
    expect(out[0]!.key).toBe("overview")
  })

  it("同 key 合并：模型可能把一类拆成多块，不合并会让一次点击堆出多类内容", () => {
    const out = buildCategories([cat("overview", [1]), cat("overview", [2])] as never, false, icon)
    expect(out).toHaveLength(1)
    expect(out[0]!.items).toEqual([1, 2])
  })

  it("分轮事件是 snake_case：clause_ids 要转成右栏用的 clauseIds", () => {
    const out = partialToCategories<{ clauseIds: string[] }>({
      categories: [{ key: "overview", title: "概况", items: [{ title: "t", clause_ids: ["sec-1-c1"] }] }],
    })
    expect(out[0]!.items[0]!.clauseIds).toEqual(["sec-1-c1"])
  })

  it("没有分轮产出时返回空表（不渲染任何类目）", () => {
    expect(partialToCategories(null)).toEqual([])
  })
})

describe("readCategories：权威结果与分轮产出的取舍", () => {
  it("权威结果一到就整体取代分轮产出（不做两边合并，避免复刻服务端语义）", () => {
    const partial = { categories: [{ key: "technical", title: "技术", items: [{ title: "分轮的" }] }] }
    const real = { categories: [{ key: "overview", title: "概况", items: [{ title: "权威的" }] }] }
    const out = readCategories<{ title: string; clauseIds: string[] }>(real as never, partial, false, icon)
    expect(out.map((c) => c.key)).toEqual(["overview"])
  })

  it("还没有权威结果时用分轮产出", () => {
    const partial = { categories: [{ key: "overview", title: "概况", items: [{ title: "分轮的" }] }] }
    const out = readCategories<{ title: string; clauseIds: string[] }>(null, partial, false, icon)
    expect(out[0]!.items[0]!.title).toBe("分轮的")
  })
})
