import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import { Hono } from "hono"
import { projectRoutes, type ProjectDeps } from "../src/routes/projects"
import { credentialsRunInput } from "../src/services/credentials"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, projectFiles, libraryItems } from "../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB

// 2026-08-09 附录系统章节（Task 1）：CredentialInput.images 从 string[] 改 {fileId,key,name}[]
// （agent 侧要 fileId 拼占位图 data-file-id，key 留给 render_docx 未来按 key 取字节），
// 下发时机从 export 步改到 content 步（正文收尾时确定性构建「资格证明文件」系统章节）。

let tokenA = ""
let userA = ""
let tokenB = ""
let userB = ""
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
// 按步记录 run_input，供 content/export 两步各自断言（末步覆盖式的 lastRunInput 在这里不够用）。
const runInputsByStep: Record<string, Record<string, unknown>> = {}

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
    runInputsByStep[input.step] = input.run_input
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
})

afterAll(async () => {
  await getDb().delete(users).where(inArray(users.id, [userA, userB])) // 项目/文件/资料库随 user 级联删
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

describe("CredentialInput 形状（images: {fileId,key,name}[]）", () => {
  it("资质条目挂 png+pdf 附件：只收图片扩展，形状含 fileId/key/name", async () => {
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

    const [item] = await getDb()
      .insert(libraryItems)
      .values({
        userId: userA,
        category: "qualification",
        title: "形状测试·营业执照",
        attachments: [
          { fileId: pngFile!.id, name: "营业执照.png" },
          { fileId: pdfFile!.id, name: "附件.pdf" },
        ],
      })
      .returning()

    try {
      const credentials = await credentialsRunInput(userA)
      expect(credentials).toEqual([
        {
          title: "形状测试·营业执照",
          images: [{ fileId: pngFile!.id, key: pngFile!.key, name: "营业执照.png" }],
        },
      ])
    } finally {
      // try/finally：断言失败也要清干净，否则本条目会串进后面的用例（跨用例污染同额度断言）。
      await getDb().delete(libraryItems).where(eq(libraryItems.id, item!.id))
    }
  })

  it("属主二次校验：附件 fileId 指向他人 project_files 行 → 该图被剔除", async () => {
    // userB 名下的文件，被 userA 的资料库条目非法引用（越权引用他人 fileId 的场景）。
    const [otherUsersFile] = await getDb()
      .insert(projectFiles)
      .values({
        userId: userB,
        bucket: "bidsaas",
        key: `uploads/${userB}/${crypto.randomUUID()}/他人文件.png`,
        filename: "他人文件.png",
        contentType: "image/png",
        size: 1,
        status: "uploaded",
      })
      .returning()

    const [item] = await getDb()
      .insert(libraryItems)
      .values({
        userId: userA,
        category: "qualification",
        title: "越权引用测试",
        attachments: [{ fileId: otherUsersFile!.id, name: "他人文件.png" }],
      })
      .returning()

    try {
      const credentials = await credentialsRunInput(userA)
      expect(credentials).toBeUndefined() // 唯一条目的唯一图片被剔除，条目整体不产出
    } finally {
      await getDb().delete(libraryItems).where(eq(libraryItems.id, item!.id))
    }
  })
})

describe("credentials 下发时机：content 步下发，export 步不下发", () => {
  it("content 步 run_input.credentials 含资质条目（对象数组形状）；export 步 run_input 无 credentials 键", async () => {
    const [pngFile] = await getDb()
      .insert(projectFiles)
      .values({
        userId: userA,
        bucket: "bidsaas",
        key: `uploads/${userA}/${crypto.randomUUID()}/资质证书.png`,
        filename: "资质证书.png",
        contentType: "image/png",
        size: 1,
        status: "uploaded",
      })
      .returning()
    const [item] = await getDb()
      .insert(libraryItems)
      .values({
        userId: userA,
        category: "qualification",
        title: "下发时机测试",
        attachments: [{ fileId: pngFile!.id, name: "资质证书.png" }],
      })
      .returning()

    try {
      const { id } = await createProject(tokenA, keyA)
      await runToExport(id, tokenA)

      expect(runInputsByStep.content?.credentials).toEqual([
        { title: "下发时机测试", images: [{ fileId: pngFile!.id, key: pngFile!.key, name: "资质证书.png" }] },
      ])
      expect(runInputsByStep.export?.credentials).toBeUndefined()
    } finally {
      await getDb().delete(libraryItems).where(eq(libraryItems.id, item!.id))
    }
  })

  it("无资质图片附件：content 步 run_input 也不带 credentials 键", async () => {
    const { id } = await createProject(tokenA, keyA)
    await runToExport(id, tokenA)
    expect(runInputsByStep.content?.credentials).toBeUndefined()
    expect(runInputsByStep.export?.credentials).toBeUndefined()
  })
})
