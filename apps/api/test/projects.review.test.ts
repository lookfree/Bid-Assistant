import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import { Hono } from "hono"
import { projectRoutes, type ProjectDeps } from "../src/routes/projects"
import * as billing from "../src/services/billing-stub"
import { seedConfigs } from "../src/services/config"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, bidProjects, projectFiles } from "../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连真库（跑法：./test-on-mbp.sh test/projects.review.test.ts）

// spec328 独立审查模块：POST /api/projects/review 建审查专用项目（kind='review'）,
// 两种模式（带/不带招标文件）;review-kind 步序只许 read/review;推进 read→review→done。

const STEP_RESULTS: Record<string, unknown> = {
  read: { categories: [], doc_sections: [{ id: "sec-1-c1", text: "须提供 ISO27001" }] },
  review: { score: 80, high: 0, mid: 1, passed: 3, items: [], passed_items: ["报价未超限"] },
}
let runStep = ""
const captured: { runInput?: Record<string, unknown> } = {}

const mockDeps: Partial<ProjectDeps> = {
  preDeduct: async (_u, op) => ({ ok: true, holdId: `hold-${op}-${crypto.randomUUID()}`, hold: 10 }),
  settle: async (_r, _h, cost) => cost,
  settleContent: async (_r, _h, held) => held,
  settleFailed: async () => {},
  createRun: async (opts) => {
    const input = opts.input as { step: string; run_input?: Record<string, unknown> }
    runStep = input.step
    captured.runInput = input.run_input
    return { run_id: crypto.randomUUID() }
  },
  relayStream: async function* () {
    yield "data: 进度\n\n"
  },
  getRun: async () => ({ status: "succeeded", result: STEP_RESULTS[runStep] }),
  getAgentModel: async () => ({
    provider: "deepseek", model: "deepseek-chat", fallbacks: "",
    params: { temperature: 0.7, max_tokens: 8192, top_p: 1 },
    chain: [{ provider: "deepseek", model: "deepseek-chat" }],
  }),
}

const app = new Hono()
app.route("/api/projects", projectRoutes(mockDeps))

let token = ""
let userId = ""
const BID_KEY = `uploads/rv/${crypto.randomUUID()}/bid.docx`
const TENDER_KEY = `uploads/rv/${crypto.randomUUID()}/tender.docx`

beforeAll(async () => {
  await seedConfigs()
  const r = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  token = r.token
  userId = r.user.id
  await getDb().insert(projectFiles).values([
    { userId, bucket: "bidsaas", key: BID_KEY, filename: "我方投标文件.docx", contentType: "application/x", size: 1, status: "uploaded" as const },
    { userId, bucket: "bidsaas", key: TENDER_KEY, filename: "采购文件.docx", contentType: "application/x", size: 1, status: "uploaded" as const },
  ])
})
afterAll(async () => {
  await getDb().delete(projectFiles).where(inArray(projectFiles.key, [BID_KEY, TENDER_KEY]))
  await getDb().delete(users).where(eq(users.id, userId))
  await closeDb()
})

const auth = () => ({ Authorization: `Bearer ${token}`, "content-type": "application/json" })
const post = (path: string, body: unknown) =>
  app.request(`http://x/api/projects${path}`, { method: "POST", headers: auth(), body: JSON.stringify(body) })

describe("spec328 独立审查项目", () => {
  it("不带招标文件：建项即站上 review 步;跑 review → run_input 带 bid_file_key,完成后整本 done", async () => {
    const res = await post("/review", { bidFileKey: BID_KEY })
    expect(res.status).toBe(200)
    const { id } = (await res.json()) as { id: string }
    const [p] = await getDb().select().from(bidProjects).where(eq(bidProjects.id, id))
    expect(p!.kind).toBe("review")
    expect(p!.currentStep).toBe("review")
    expect(p!.status).toBe("running")
    expect(p!.name).toContain("（审查）")

    const run = await post(`/${id}/steps/review`, {})
    expect(run.status).toBe(200)
    await run.text() // 排干 SSE，等收尾完成
    expect(captured.runInput?.bid_file_key).toBe(BID_KEY) // 线下标书 key 随 run 下发
    const [after] = await getDb().select().from(bidProjects).where(eq(bidProjects.id, id))
    expect(after!.currentStep).toBe("done")
    expect(after!.status).toBe("done")
  })

  it("带招标文件：draft 起步先读标,read 完成推进到 review（跳过 outline/content）", async () => {
    const res = await post("/review", { bidFileKey: BID_KEY, tenderFileKey: TENDER_KEY })
    const { id } = (await res.json()) as { id: string }
    const [p] = await getDb().select().from(bidProjects).where(eq(bidProjects.id, id))
    expect(p!.currentStep).toBe("read")
    expect(p!.status).toBe("draft")

    const readRun = await post(`/${id}/steps/read`, {})
    expect(readRun.status).toBe(200)
    await readRun.text()
    const [afterRead] = await getDb().select().from(bidProjects).where(eq(bidProjects.id, id))
    expect(afterRead!.currentStep).toBe("review") // 不经 outline/content

    const reviewRun = await post(`/${id}/steps/review`, {})
    expect(reviewRun.status).toBe(200)
    await reviewRun.text()
    const [done] = await getDb().select().from(bidProjects).where(eq(bidProjects.id, id))
    expect(done!.currentStep).toBe("done")
  })

  it("review-kind 禁生成/导出步：outline/export → 409;未上传的文件 key → 400", async () => {
    const res = await post("/review", { bidFileKey: BID_KEY })
    const { id } = (await res.json()) as { id: string }
    expect((await post(`/${id}/steps/outline`, {})).status).toBe(409)
    expect((await post(`/${id}/steps/export`, {})).status).toBe(409)
    expect((await post("/review", { bidFileKey: "uploads/nobody/else.docx" })).status).toBe(400)
  })
})
