import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { projectRoutes, type ProjectDeps } from "../src/routes/projects"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, bidProjects, projectSteps, creditTransactions, plans, subscriptions } from "../src/db/schema"
import { uniquePhone, makeTestPlan, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS)

/* 述标导出前的免费重渲（生产缺陷 2026-07-30）：
   述标页「导出」只取预签名 URL 直下已存对象，用户在编辑器改完 deck 再导出仍是编辑前那份 PPT，
   可能就这么带去投标。而「用户自己上传标书」那条（kind=review）的 export 步一律被拒，
   连补跑 export 重渲都做不到——两条入口必须共用这一条免费重渲路径，结果才会一致。 */

let token = ""
let userId = ""
let normalId = ""
let reviewId = ""
let normalThread = ""
let reviewThread = ""
let reviewStepId = ""
const rendered: Array<{ threadId: string; deck: unknown; enterpriseTemplateKey?: string | null }> = []
const madePlans: string[] = []
let renderFails = false
const presigned: string[] = []

const mockDeps: Partial<ProjectDeps> = {
  renderDeck: async ({ threadId, deck, enterpriseTemplateKey }) => {
    if (renderFails) throw new Error("agent down")
    rendered.push({ threadId, deck, enterpriseTemplateKey })
    return { key: `artifacts/${threadId}/present.pptx` }
  },
  presignGet: async (key: string) => {
    presigned.push(key)
    return `https://minio.example/${key}?sig=x`
  },
}

const app = new Hono()
app.route("/api/projects", projectRoutes(mockDeps))

const auth = () => ({ Authorization: `Bearer ${token}` })
const post = (id: string) =>
  app.request(`/api/projects/${id}/present/pptx`, { method: "POST", headers: auth() })

const DECK = { title: "述标", duration: 15, template: "blue", slides: [{ id: "s1", title: "页", kind: "content", bullets: ["改后的要点"] }] }

beforeAll(async () => {
  const r = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => "ok" as const)
  token = r.token
  userId = r.user.id

  normalThread = `proj-${crypto.randomUUID()}`
  const [n] = await getDb().insert(bidProjects)
    .values({ userId, threadId: normalThread, currentStep: "export", status: "active" }).returning()
  normalId = n!.id
  await getDb().insert(projectSteps).values({ projectId: normalId, step: "present", status: "done", result: DECK })

  reviewThread = `proj-${crypto.randomUUID()}`
  const [v] = await getDb().insert(bidProjects)
    .values({ userId, threadId: reviewThread, kind: "review", currentStep: "review", status: "active" }).returning()
  reviewId = v!.id
  const [rs] = await getDb().insert(projectSteps)
    .values({ projectId: reviewId, step: "present", status: "done", result: DECK }).returning()
  reviewStepId = rs!.id
})

afterAll(async () => {
  await getDb().delete(subscriptions).where(eq(subscriptions.userId, userId))
  await getDb().delete(users).where(eq(users.id, userId))
  for (const id of madePlans) await getDb().delete(plans).where(eq(plans.id, id))
  await closeDb()
})

describe("POST /api/projects/:id/present/pptx —— 导出前免费重渲", () => {
  it("拿存库 deck 重渲并返回预签名 URL（编辑后的内容才会进产物）", async () => {
    const res = await post(normalId)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { url: string; filename: string }
    expect(body.url).toContain(`artifacts/${normalThread}/present.pptx`)
    expect(body.filename).toEndWith(".pptx")
    const last = rendered.at(-1)!
    expect(last.threadId).toBe(normalThread)
    expect(JSON.stringify(last.deck)).toContain("改后的要点")
  })

  it("上传标书那条（kind=review）走同一条路，线程按 run 派生规则算", async () => {
    const res = await post(reviewId)
    expect(res.status).toBe(200)
    // review-kind 述标跑在专属线程 `<threadId>-present-<步位行id>` 上，产物 key 必须对得上
    expect(rendered.at(-1)!.threadId).toBe(`${reviewThread}-present-${reviewStepId}`)
  })

  it("免费：不产生任何积分流水", async () => {
    const before = await getDb().select().from(creditTransactions).where(eq(creditTransactions.userId, userId))
    await post(normalId)
    const after = await getDb().select().from(creditTransactions).where(eq(creditTransactions.userId, userId))
    expect(after.length).toBe(before.length)
  })

  it("没跑过述标的项目 404，不去调渲染", async () => {
    const [p] = await getDb().insert(bidProjects)
      .values({ userId, threadId: `proj-${crypto.randomUUID()}` }).returning()
    const n = rendered.length
    const res = await post(p!.id)
    expect(res.status).toBe(404)
    expect(rendered.length).toBe(n)
  })

  it("档位不含 pptTemplate 时剥掉企业模板——降级后不能继续白用付费母版", async () => {
    // deck 里的 enterprise_template_id 是「专业版时期设置」的持久物，会一直留在库里；
    // guardedOverrides 早就为 export/present 重渲做了这道剥除，新的免费导出路径必须同口径。
    const [p] = await getDb().insert(bidProjects)
      .values({ userId, threadId: `proj-${crypto.randomUUID()}` }).returning()
    await getDb().insert(projectSteps).values({
      projectId: p!.id, step: "present", status: "done",
      result: { ...DECK, enterprise_template_id: "library/master.pptx" },
    })
    // 无订阅 → 回落免费档；只要免费档 features.pptTemplate 显式 false 就该剥掉
    const planId = await makeTestPlan((id) => madePlans.push(id), {})
    await getDb().update(plans).set({ features: { pptTemplate: false } }).where(eq(plans.id, planId))
    await getDb().insert(subscriptions)
      .values({ userId, planId, status: "active", currentPeriodEnd: new Date(Date.now() + 86_400_000) })
    const res = await post(p!.id)
    expect(res.status).toBe(200)
    expect(rendered.at(-1)!.enterpriseTemplateKey).toBeNull()
    await getDb().delete(subscriptions).where(eq(subscriptions.userId, userId))
  })

  it("agent 渲染失败 → 502，不是裸 500", async () => {
    // 导出现在只有这一条路，前端要能区分「服务挂了」和「自己的 deck 有问题」
    renderFails = true
    const res = await post(normalId)
    renderFails = false
    expect(res.status).toBe(502)
    expect((await res.json()) as { error: string }).toEqual({ error: "agent_failed" })
  })

  it("不是自己的项目一律 404", async () => {
    const other = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => "ok" as const)
    const res = await app.request(`/api/projects/${normalId}/present/pptx`, {
      method: "POST", headers: { Authorization: `Bearer ${other.token}` },
    })
    expect(res.status).toBe(404)
    await getDb().delete(users).where(eq(users.id, other.user.id))
  })
})
