import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { projectRoutes, type ProjectDeps } from "../src/routes/projects"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, projectFiles, libraryItems } from "../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB

// spec325：export 步 run_input.credentials 下发——取用户「资质」类资料库条目的图片附件 key，
// 无资质图片附件则不带该键；非图片扩展（pdf）附件被过滤，不进 credentials.images。

let tokenA = ""
let userA = ""
let keyA = ""

// 各步 agent result（snake 原样）：走完整六步才能到 export，内容对本用例无关紧要，能过各步校验即可。
const STEP_RESULTS: Record<string, unknown> = {
  read: { categories: [], doc_sections: [] },
  outline: { chapters: [{ id: "ch-1", chapter_title: "技术方案", clause_ids: [] }] },
  content: { "ch-1": "<p>正文</p>" },
  review: { issues: [] },
  present: { deck: { slides: [] } },
  export: { docx_key: "exports/x.docx" },
}
let runStep = ""
let lastRunInput: Record<string, unknown> = {}

const mockDeps: Partial<ProjectDeps> = {
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

beforeAll(async () => {
  const a = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  tokenA = a.token
  userA = a.user.id

  keyA = `uploads/${userA}/${crypto.randomUUID()}/招标文件.pdf`
  await getDb()
    .insert(projectFiles)
    .values({ userId: userA, bucket: "bidsaas", key: keyA, filename: "招标文件.pdf", contentType: "application/pdf", size: 1, status: "uploaded" })
})

afterAll(async () => {
  await getDb().delete(users).where(eq(users.id, userA)) // 项目/文件/资料库随 user 级联删
  await closeDb()
})

const auth = (token: string) => ({ Authorization: `Bearer ${token}`, "content-type": "application/json" })

const createProject = async (token: string, fileKey: string) => {
  const res = await app.request("/api/projects", { method: "POST", headers: auth(token), body: JSON.stringify({ fileKey }) })
  expect(res.status).toBe(200)
  return (await res.json()) as { id: string; threadId: string }
}

const STEPS = ["read", "outline", "content", "review", "present", "export"] as const

// 依序推进六步到 export；每步 200 是各步前置条件满足的先决（out_of_order 会 409）。
async function runToExport(projectId: string, token: string) {
  for (const step of STEPS) {
    const res = await app.request(`/api/projects/${projectId}/steps/${step}`, { method: "POST", headers: auth(token) })
    expect(res.status).toBe(200)
    await res.text()
  }
}

describe("run_input.credentials 下发（spec325）", () => {
  it("无资质图片附件：export 步 run_input 不带 credentials 键", async () => {
    const { id } = await createProject(tokenA, keyA)
    await runToExport(id, tokenA)
    expect(runStep).toBe("export")
    expect(lastRunInput.credentials).toBeUndefined()
  })

  it("资质条目挂 png 附件：export 步 run_input.credentials 含 title+images（pdf 附件被过滤）", async () => {
    const [pngFile] = await getDb()
      .insert(projectFiles)
      .values({
        userId: userA,
        bucket: "bidsaas",
        key: `uploads/${userA}/${crypto.randomUUID()}/营业执照.png`,
        filename: "营业执照.png",
        contentType: "image/png",
        size: 1,
        status: "uploaded",
      })
      .returning()
    const [pdfFile] = await getDb()
      .insert(projectFiles)
      .values({
        userId: userA,
        bucket: "bidsaas",
        key: `uploads/${userA}/${crypto.randomUUID()}/附件.pdf`,
        filename: "附件.pdf",
        contentType: "application/pdf",
        size: 1,
        status: "uploaded",
      })
      .returning()

    await getDb()
      .insert(libraryItems)
      .values({
        userId: userA,
        category: "qualification",
        title: "营业执照",
        attachments: [
          { fileId: pngFile!.id, name: "营业执照.png" },
          { fileId: pdfFile!.id, name: "附件.pdf" },
        ],
      })

    const { id } = await createProject(tokenA, keyA)
    await runToExport(id, tokenA)
    expect(lastRunInput.credentials).toEqual([{ title: "营业执照", images: [pngFile!.key] }])
  })
})
