import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { inArray } from "drizzle-orm"
import { Hono } from "hono"
import { projectRoutes, type ProjectDeps } from "../src/routes/projects"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, projectFiles, libraryItems } from "../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB

// Task 3：export 步 run_input.export_scope 透传 + GET /:id/export-preview 预告接口
// （资质条目 title+imageCount，他人项目 404）。上游 agent 侧 export_scope 消费见 Task 2；
// 这里只测 App API 这一层的组装与预告。
// 2026-08-09 附录系统章节 Task 1：credentials 下发时机从 export 步改到 content 步——
// export 步 run_input 不再带 credentials 键（与 scope 取值无关），相关断言随之退役。

let tokenA = ""
let userA = ""
let tokenB = ""
let userB = ""
let keyA = ""
let projectId = ""

// export 步结果要满足 resultShapeOk（docx/pptx 二选一有字符串值），其余步沿用既有测试同款样板。
const STEP_RESULTS: Record<string, unknown> = {
  read: { categories: [], doc_sections: [] },
  outline: { chapters: [{ id: "ch-1", chapter_title: "技术方案", clause_ids: [] }] },
  content: { "ch-1": "<p>正文</p>" },
  review: { issues: [] },
  present: { title: "述标", duration: 15, template: "gov", slides: [{ id: "s-1", title: "封面" }], qa: [] },
  export: { docx: "artifacts/x/bid.docx" },
}
let runStep = ""
let lastRunInput: Record<string, unknown> = {}

const mockDeps: Partial<ProjectDeps> = {
  // 必须注入：否则 content 步会去读共享库的 credit_cost.content_tiers，本文件既不种键也不还原，
  // 在没种过该键的库上会 400 content_tiers_not_configured，测试挂在与本文件无关的原因上。
  resolveStepHoldAmount: async (step: string) => (step === "content" ? 260 : undefined),
  preDeduct: async () => ({ ok: true, holdId: "hold-x", hold: 10 }),
  settle: async (_ref, _holdId, actualCost) => actualCost,
  settleContent: async (_ref, _holdId, heldAmount) => heldAmount,
  settleFailed: async () => {},
  createRun: async (opts) => {
    const input = opts.input as { step: string; run_input: Record<string, unknown> }
    runStep = input.step
    lastRunInput = input.run_input
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

const auth = (token: string) => ({ Authorization: `Bearer ${token}`, "content-type": "application/json" })

beforeAll(async () => {
  const a = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => "ok" as const)
  tokenA = a.token
  userA = a.user.id
  const b = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => "ok" as const)
  tokenB = b.token
  userB = b.user.id

  keyA = `uploads/${userA}/${crypto.randomUUID()}/招标文件.pdf`
  await getDb()
    .insert(projectFiles)
    .values({ userId: userA, bucket: "bidsaas", key: keyA, filename: "招标文件.pdf", contentType: "application/pdf", size: 1, status: "uploaded" })

  // 资质条目 2 项，各挂 1 张 png 附件（export-preview 断言 {title,imageCount:1}×2 的样本）
  for (const title of ["营业执照", "安全生产许可证"]) {
    const [file] = await getDb()
      .insert(projectFiles)
      .values({
        userId: userA,
        bucket: "bidsaas",
        key: `uploads/${userA}/${crypto.randomUUID()}/${title}.png`,
        filename: `${title}.png`,
        contentType: "image/png",
        size: 1,
        status: "uploaded",
      })
      .returning()
    await getDb()
      .insert(libraryItems)
      .values({ userId: userA, category: "qualification", title, attachments: [{ fileId: file!.id, name: `${title}.png` }] })
  }

  const created = await app.request("/api/projects", { method: "POST", headers: auth(tokenA), body: JSON.stringify({ fileKey: keyA }) })
  expect(created.status).toBe(200)
  const { id } = (await created.json()) as { id: string }
  projectId = id

  // 走完 read→outline→content→review→present，把 currentStep 推到 export 前置条件满足处
  // （export 允许在 currentStep 为 review/present/done 时反复调用，见 projects.ts 步序校验）。
  for (const step of ["read", "outline", "content", "review", "present"] as const) {
    const res = await app.request(`/api/projects/${projectId}/steps/${step}`, { method: "POST", headers: auth(tokenA) })
    expect(res.status).toBe(200)
    await res.text()
  }
})

afterAll(async () => {
  await getDb().delete(users).where(inArray(users.id, [userA, userB])) // 项目/文件/资料库随 user 级联删
  await closeDb()
})

// export 步可反复调用（currentStep 已在 review/present/done 之一）：每个用例传不同 body 复验一次。
const runExport = async (body: Record<string, unknown>) => {
  const res = await app.request(`/api/projects/${projectId}/steps/export`, { method: "POST", headers: auth(tokenA), body: JSON.stringify(body) })
  expect(res.status).toBe(200)
  await res.text()
}

describe("export_scope 透传（Task 3）", () => {
  it('scope="tech"：run_input.export_scope==="tech"，且不下发 credentials 键', async () => {
    await runExport({ export_scope: "tech" })
    expect(lastRunInput.export_scope).toBe("tech")
    expect(lastRunInput.credentials).toBeUndefined()
  })

  it("scope 缺省：run_input 无 export_scope 键，credentials 键不下发（Task 1 已改为 content 步下发）", async () => {
    await runExport({})
    expect(lastRunInput.export_scope).toBeUndefined()
    expect(lastRunInput.credentials).toBeUndefined()
  })

  it('scope="full"：与缺省同（run_input 无 export_scope 键），credentials 键不下发', async () => {
    await runExport({ export_scope: "full" })
    expect(lastRunInput.export_scope).toBeUndefined()
    expect(lastRunInput.credentials).toBeUndefined()
  })
})

describe("GET /:id/export-preview（Task 3）", () => {
  it("资质条目 2 项各 1 图 → {credentials:[{title,imageCount:1}×2]}", async () => {
    const res = await app.request(`/api/projects/${projectId}/export-preview`, { headers: auth(tokenA) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { credentials: { title: string; imageCount: number }[] }
    expect(body.credentials.slice().sort((x, y) => x.title.localeCompare(y.title))).toEqual([
      { title: "安全生产许可证", imageCount: 1 },
      { title: "营业执照", imageCount: 1 },
    ])
  })

  it("他人项目 → 404", async () => {
    const res = await app.request(`/api/projects/${projectId}/export-preview`, { headers: auth(tokenB) })
    expect(res.status).toBe(404)
  })
})
