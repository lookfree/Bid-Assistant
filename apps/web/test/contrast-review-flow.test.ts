/**
 * 对照审查的编排规则（纯逻辑，不渲染组件）。
 *
 * 用户反馈：上传两份文件后被跳去招标解读，等它跑完再自己回来点生成。应当直接出对照审查。
 * 读标不能省——对照要拿招标要求清单去比对，那份清单正是读标产出的；它只能**藏起来**。
 *
 * 唯一藏不掉的是选包：多包件不选包，就会拿所有包的★要求去比对单包的投标文件，
 * 别的包的要求全被误报成「未响应」。线上 53 个读过标的项目里 21 个是多包件（39%）。
 */
import { describe, it, expect } from "bun:test"
import { contrastReviewCost, needsRead, nextContrastPhase, shouldConverge } from "@/lib/contrast-flow"

describe("nextContrastPhase", () => {
  it("单包：读完直接跑对照，不打断用户", () => {
    expect(nextContrastPhase(1)).toBe("review")
    expect(nextContrastPhase(0)).toBe("review")   // 没解析出包件视同单包
  })

  it("多包：必须停下来让人选包", () => {
    expect(nextContrastPhase(2)).toBe("pick")
    expect(nextContrastPhase(7)).toBe("pick")
  })

  it("边界就在 1 和 2 之间——写成 >=1 会把单包也拦下来，写成 >2 会让两个包的标漏选", () => {
    expect(nextContrastPhase(1)).not.toBe("pick")
    expect(nextContrastPhase(2)).not.toBe("review")
  })
})

describe("断流不等于失败", () => {
  it("断流/已在跑/已跑完 → 转轮询取结果", () => {
    // 读标 2–5 分钟，SSE 被代理掐断是常事；报失败会让用户对着一次已扣费的成功重试
    expect(shouldConverge("stream-incomplete")).toBe(true)
    expect(shouldConverge("already-running")).toBe(true)
    expect(shouldConverge("already-done")).toBe(true)
  })

  it("真失败照常报出来", () => {
    expect(shouldConverge("other")).toBe(false)
  })
})

describe("读标不重跑", () => {
  it("已有读标结果就直接用", () => {
    // 重跑要么再扣 20 积分，要么被步序闸 409 拒死（读完 currentStep 已推进到 review）
    expect(needsRead(true)).toBe(false)
  })

  it("没有才跑", () => {
    expect(needsRead(false)).toBe(true)
  })
})

describe("contrastReviewCost（CTA 报价，逐行#7：重试路径不能多报价）", () => {
  it("读标已完成——只收审查费，跟 start() 内部 needsRead() 同口径", () => {
    expect(contrastReviewCost(true, 20, 60)).toBe(60)
  })

  it("读标未完成——含读标+审查总价", () => {
    expect(contrastReviewCost(false, 20, 60)).toBe(80)
  })
})
