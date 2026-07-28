import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import { Hono } from "hono"
import { projectRoutes, type ProjectDeps } from "../src/routes/projects"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, plans, subscriptions, bidProjects, projectSteps, projectFiles, libraryItems } from "../src/db/schema"
import { uniquePhone, makeTestPlan, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连真库（跑法：./test-local.sh test/projects.advice-gate.test.ts）

// 档位权益执行门禁（评审修正,方案 A）——三个执行点的路由级契约：
//  1) review 结果出口：非会员 items[].advice 不下发（置空+adviceLocked）,会员原文;
//     此前 API 全量下发、仅前端模糊遮挡,F12 即可读（实拍复现）;
//  2) 单章改写：档位 features.rewrite 显式 false → 403 feature_locked（先于预扣,分文不动）;
//  3) 述标企业 PPT 模板：features.pptTemplate 显式 false 且请求带模板 → 403（先于占位/预扣）。

let preDeductCalls = 0
const mockDeps: Partial<ProjectDeps> = {
  preDeduct: async () => {
    preDeductCalls++
    return { ok: true, holdId: crypto.randomUUID(), hold: 25 }
  },
  settle: async () => 25,
  rewriteChapter: async (opts) => ({ chapter_id: opts.chapterId, html: "<p>改写后</p>" }),
  getAgentModel: async () => ({ provider: "deepseek", model: "test-model" }) as never,
}
const app = new Hono()
app.route("/api/projects", projectRoutes(mockDeps))

const madeUsers: string[] = []
const madePlans: string[] = []
const madeProjects: string[] = []

let freeToken = "" // 无订阅（免费口径）
let lockedToken = "" // active 订阅但 features 显式 false
let lockedUserId = ""
let proToken = "" // active 订阅 features 全开
let proUserId = ""

const auth = (tk: string) => ({ Authorization: `Bearer ${tk}`, "content-type": "application/json" })

/** 建带订阅的登录用户（要 token 走路由,不能用 makeLedgerUser）。 */
async function memberUser(features: Record<string, unknown>): Promise<{ token: string; userId: string }> {
  const { token, user } = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  madeUsers.push(user.id)
  const planId = await makeTestPlan((id) => madePlans.push(id), {})
  await getDb().update(plans).set({ features }).where(eq(plans.id, planId))
  await getDb().insert(subscriptions).values({
    userId: user.id, planId, status: "active", currentPeriodEnd: new Date(Date.now() + 86_400_000),
  })
  return { token, userId: user.id }
}

/** 建项目 + review done 行（snake_case result,库中原样）。 */
async function projectWithReview(userId: string): Promise<string> {
  const [p] = await getDb()
    .insert(bidProjects)
    .values({ userId, threadId: `proj-${crypto.randomUUID()}`, status: "running", currentStep: "content" })
    .returning()
  madeProjects.push(p!.id)
  await getDb().insert(projectSteps).values({
    projectId: p!.id, step: "review", status: "done",
    result: {
      score: 45, high: 1, mid: 0, passed: 2,
      items: [{ level: "高", tone: "destructive", title: "缺 ISO27001", advice: "在资质章补认证扫描件", tender_ref: "第三章", chapter_title: "资质文件", target_tab: "business", target_id: "b2" }],
      passed_items: ["格式合规"],
    },
  })
  return p!.id
}

beforeAll(async () => {
  const free = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  freeToken = free.token
  madeUsers.push(free.user.id)
  ;({ token: lockedToken, userId: lockedUserId } = await memberUser({ rewrite: false, pptTemplate: false }))
  ;({ token: proToken, userId: proUserId } = await memberUser({ rewrite: true, pptTemplate: true }))
})

afterAll(async () => {
  await getDb().delete(projectSteps).where(inArray(projectSteps.projectId, madeProjects))
  await getDb().delete(bidProjects).where(inArray(bidProjects.id, madeProjects))
  await getDb().delete(subscriptions).where(inArray(subscriptions.userId, madeUsers))
  await getDb().delete(users).where(inArray(users.id, madeUsers))
  await getDb().delete(plans).where(inArray(plans.id, madePlans))
  await closeDb()
})

describe("review 结果出口裁剪（advice 只给会员）", () => {
  it("非会员：GET 单步结果 advice 置空 + adviceLocked;项目详情里同样裁剪", async () => {
    const free = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
    madeUsers.push(free.user.id)
    const pid = await projectWithReview(free.user.id)

    const res = await app.request(`http://x/api/projects/${pid}/steps/review/result`, { headers: auth(free.token) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { adviceLocked?: boolean; items: Array<{ advice: string; title: string; tenderRef: string }> } }
    expect(body.result.adviceLocked).toBe(true)
    expect(body.result.items[0]!.advice).toBe("")
    expect(body.result.items[0]!.title).toBe("缺 ISO27001") // 其余字段不受影响
    expect(body.result.items[0]!.tenderRef).toBe("第三章") // camelCase 转换正常叠加

    const detail = await app.request(`http://x/api/projects/${pid}`, { headers: auth(free.token) })
    const dbody = (await detail.json()) as { steps: Array<{ step: string; result: { adviceLocked?: boolean; items: Array<{ advice: string }> } }> }
    const review = dbody.steps.find((s) => s.step === "review")!
    expect(review.result.adviceLocked).toBe(true)
    expect(review.result.items[0]!.advice).toBe("")
  })

  it("会员（active 订阅）：advice 原文下发,无 adviceLocked", async () => {
    const pid = await projectWithReview(proUserId)
    const res = await app.request(`http://x/api/projects/${pid}/steps/review/result`, { headers: auth(proToken) })
    const body = (await res.json()) as { result: { adviceLocked?: boolean; items: Array<{ advice: string }> } }
    expect(body.result.adviceLocked).toBeUndefined()
    expect(body.result.items[0]!.advice).toBe("在资质章补认证扫描件")
  })
})

describe("单章改写档位门禁（features.rewrite）", () => {
  it("档位显式 rewrite:false → 403 feature_locked,分文未扣（预扣不被调用）", async () => {
    const pid = await projectWithReview(lockedUserId)
    preDeductCalls = 0
    const res = await app.request(`http://x/api/projects/${pid}/chapters/ch-1/rewrite`, {
      method: "POST", headers: auth(lockedToken), body: JSON.stringify({ instruction: "更正式一点" }),
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string; feature: string })).toEqual({ error: "feature_locked", feature: "rewrite" })
    expect(preDeductCalls).toBe(0)
  })

  it("档位 rewrite:true → 放行走完整链路（content done 后 200）", async () => {
    const pid = await projectWithReview(proUserId)
    await getDb().insert(projectSteps).values({ projectId: pid, step: "content", status: "done", result: { "ch-1": "<p>原文</p>" } })
    const res = await app.request(`http://x/api/projects/${pid}/chapters/ch-1/rewrite`, {
      method: "POST", headers: auth(proToken), body: JSON.stringify({ instruction: "更正式一点" }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { html: string }).html).toBe("<p>改写后</p>")
  })
})

describe("述标企业模板档位门禁（features.pptTemplate）", () => {
  /** 建 presentation 资料项（带本人 pptx 附件）→ enterpriseTemplateItemId 可解析出模板 key。 */
  async function pptxItem(userId: string): Promise<string> {
    const [f] = await getDb().insert(projectFiles).values({
      userId, bucket: "bidsaas", key: `uploads/${userId}/master.pptx`, filename: "企业模板.pptx",
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", size: 1, status: "uploaded",
    }).returning()
    const [item] = await getDb().insert(libraryItems).values({
      userId, category: "presentation", title: "企业模板", attachments: [{ fileId: f!.id, name: "企业模板.pptx" }],
    }).returning()
    return item!.id
  }

  it("档位显式 pptTemplate:false 且带模板 → 403;不带模板不触发门禁（走既有跳步校验）", async () => {
    const pid = await projectWithReview(lockedUserId)
    const item = await pptxItem(lockedUserId)
    const res = await app.request(`http://x/api/projects/${pid}/steps/present`, {
      method: "POST", headers: auth(lockedToken), body: JSON.stringify({ duration: 15, enterpriseTemplateItemId: item }),
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { feature: string }).feature).toBe("pptTemplate")

    const plain = await app.request(`http://x/api/projects/${pid}/steps/present`, {
      method: "POST", headers: auth(lockedToken), body: JSON.stringify({ duration: 15 }),
    })
    expect(plain.status).not.toBe(403) // 未用模板不锁（本项目停在 content 步 → 409 跳步）
  })

  it("档位 pptTemplate:true 带模板 → 不触发 403（后续走既有跳步校验）", async () => {
    const pid = await projectWithReview(proUserId)
    const item = await pptxItem(proUserId)
    const res = await app.request(`http://x/api/projects/${pid}/steps/present`, {
      method: "POST", headers: auth(proToken), body: JSON.stringify({ duration: 15, enterpriseTemplateItemId: item }),
    })
    expect(res.status).not.toBe(403)
  })
})
