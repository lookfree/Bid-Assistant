import { describe, it, expect } from "bun:test"
import { stepNotApplicable, stepPrereq, mergeReadPart } from "../lib/use-step"
import type { ProjectInfo } from "../lib/project"

function info(currentStep: string, kind?: "bid" | "review", tenderFileKey: string | null = null): ProjectInfo {
  return {
    project: {
      id: "p1", threadId: "t1", name: "项目", status: "running", currentStep,
      tenderFileKey, kind, selectedPackage: null,
    },
    steps: [],
  }
}

describe("stepPrereq", () => {
  it("正常流水线：前序未完成返回该步入口，已完成/持平返回 null", () => {
    expect(stepPrereq(info("read"), "content")).toEqual({ href: "/read", label: "招标解读" })
    expect(stepPrereq(info("content"), "content")).toBeNull()
    expect(stepPrereq(info("review"), "content")).toBeNull() // 已过 content，无缺口
    expect(stepPrereq(null, "present")).toBeNull()
  })

  it("spec328+ 独立述标：kind=review 项目请求 present 恒不设前序缺口（不看 currentStep）", () => {
    expect(stepPrereq(info("read", "review"), "present")).toBeNull() // 连 read 都没跑
    expect(stepPrereq(info("review", "review"), "present")).toBeNull() // review 没跑过
    expect(stepPrereq(info("done", "review"), "present")).toBeNull()
  })

  it("kind=review 项目请求非 present 的步（如 review）仍按正常前序判定", () => {
    expect(stepPrereq(info("read", "review"), "review")).toEqual({ href: "/read", label: "招标解读" })
  })

  it("kind=bid（或未标注）项目请求 present 仍按正常前序判定（不受 review-kind 豁免影响）", () => {
    expect(stepPrereq(info("outline", "bid"), "present")).toEqual({ href: "/outline", label: "提纲生成" })
    expect(stepPrereq(info("outline"), "present")).toEqual({ href: "/outline", label: "提纲生成" })
  })
})

describe("stepNotApplicable：审查项目不适用的步不得亮计费按钮", () => {
  it("线下标书审查（无招标文件）：读标/提纲/正文一律给去审查的引导", () => {
    const guide = { href: "/risk", label: "标书审查" }
    // 生产实测：从标书审查进来的项目点开「招标解读」，点按钮后报 409「步骤顺序不符」
    expect(stepNotApplicable(info("review", "review"), "read")).toEqual(guide)
    expect(stepNotApplicable(info("review", "review"), "outline")).toEqual(guide)
    expect(stepNotApplicable(info("review", "review"), "content")).toEqual(guide)
  })

  it("附了招标文件的对照审查：读标照跑（后端也放行）", () => {
    expect(stepNotApplicable(info("read", "review", "uploads/u/tender.pdf"), "read")).toBeNull()
  })

  it("审查与述标本身恒适用；普通生成项目一律不拦", () => {
    expect(stepNotApplicable(info("review", "review"), "review")).toBeNull()
    expect(stepNotApplicable(info("review", "review"), "present")).toBeNull()
    expect(stepNotApplicable(info("read"), "read")).toBeNull()
    expect(stepNotApplicable(null, "read")).toBeNull()
  })
})

// 步骤跑完后的状态刷新（2026-08-01 生产实测）：页面下方结果都出来了，右上角流程导航的
// 「招标解读进行中」胶囊还在转——因为它读的是 info.steps，而 start() 的 finally 只复位了
// 本页横幅用的 running，从没重新拉过 info。这里钉住「finally 里必须刷新项目状态」。
describe("useStep：步骤结束必须刷新项目状态", () => {
  it("start() 的收尾同时失效缓存并重新拉 info（否则 info.steps 永远停在 running）", async () => {
    const src = await Bun.file(new URL("../lib/use-step.ts", import.meta.url)).text()
    const tail = src.slice(src.indexOf("} finally {"), src.indexOf("[projectId, step, running],"))
    expect(tail).toContain("setRunning(false)")
    expect(tail).toContain("invalidateProjectCache(projectId)")
    expect(tail).toContain("getProject(projectId, { fresh: true })")
    expect(tail).toContain("setInfo(")
  })
})

// 读标分轮上屏（2026-08-01）：大标书分 10 轮跑十几分钟，基础轮一两分钟就能出「项目概况/资格要求」，
// 没理由让用户干等。累加只为展示，权威结果随 step.done 整体覆盖。
describe("mergeReadPart：分轮产出累加（仅展示态）", () => {
  it("同 key 分类合并、条目追加；数组字段拼接；标量覆盖", () => {
    const a = mergeReadPart(null, {
      project_meta: { name: "某平台采购" },
      categories: [{ key: "overview", title: "项目概况", items: [{ title: "预算" }] }],
    })
    const b = mergeReadPart(a, {
      categories: [
        { key: "overview", title: "项目概况", items: [{ title: "工期" }] },
        { key: "technical", title: "技术需求", items: [{ title: "参数A" }] },
      ],
      risk_summary: ["未密封作废标"],
    })
    const cats = b.categories as { key: string; items: unknown[] }[]
    expect(cats).toHaveLength(2)
    expect(cats.find((c) => c.key === "overview")!.items).toHaveLength(2) // 两轮的条目都在
    expect(b.risk_summary).toEqual(["未密封作废标"])
    expect(b.project_meta).toEqual({ name: "某平台采购" }) // 先前轮次的字段不被后续轮清掉
  })

  it("不复刻服务端合并语义：前端只做并集，权威结果由 step.done 整体覆盖", () => {
    // 这里刻意不做「按包件过滤」「技术项清 packages 标签」等服务端才有的处理——
    // 两处各写一份迟早漂，展示态错一会儿无害，业务判断一律以最终结果为准。
    const merged = mergeReadPart({ scoring: [{ id: "s1" }] }, { scoring: [{ id: "s2" }] })
    expect(merged.scoring).toHaveLength(2)
  })
})
