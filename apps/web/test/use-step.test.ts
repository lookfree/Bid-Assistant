import { describe, it, expect } from "bun:test"
import { stepPrereq } from "../lib/use-step"
import type { ProjectInfo } from "../lib/project"

function info(currentStep: string, kind?: "bid" | "review"): ProjectInfo {
  return {
    project: {
      id: "p1", threadId: "t1", name: "项目", status: "running", currentStep,
      tenderFileKey: null, kind, selectedPackage: null,
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
