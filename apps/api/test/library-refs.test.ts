import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import { Hono } from "hono"
import { projectRoutes, type ProjectDeps } from "../src/routes/projects"
import { credentialsRunInput, libraryRefsRunInput } from "../src/services/credentials"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, projectFiles, libraryItems } from "../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB

// 2026-08-09 资料库定向注入（Task 2）：
// ① content 步 run_input 增发 library_refs（人员/业绩条目，按章关键词命中确定性拼进简报，不再赌
//   RAG 召回率）；② credentials.images 附件透传 ocrText（agent 拼占位图 alt 用）。两者都只在
// content 步下发，export 步无需再感知。

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

describe("libraryRefsRunInput 形状与截断", () => {
  it("①人员/业绩条目齐全 → 形状字段齐（title/meta/fields/body）", async () => {
    const [p] = await getDb()
      .insert(libraryItems)
      .values({
        userId: userA,
        category: "personnel",
        title: "张三",
        meta: "项目经理",
        fields: [{ label: "职称", value: "高级工程师" }],
        body: "十年同类项目经验",
      })
      .returning()
    const [perf] = await getDb()
      .insert(libraryItems)
      .values({
        userId: userA,
        category: "performance",
        title: "某市政道路改造项目",
        meta: "2024 年",
        fields: [{ label: "合同额", value: "500 万元" }],
        body: "按期顺利交付",
      })
      .returning()

    try {
      const result = await libraryRefsRunInput(userA)
      expect(result.library_refs?.personnel).toEqual([
        { title: "张三", meta: "项目经理", fields: [{ label: "职称", value: "高级工程师" }], body: "十年同类项目经验" },
      ])
      expect(result.library_refs?.performance).toEqual([
        { title: "某市政道路改造项目", meta: "2024 年", fields: [{ label: "合同额", value: "500 万元" }], body: "按期顺利交付" },
      ])
    } finally {
      await getDb().delete(libraryItems).where(inArray(libraryItems.id, [p!.id, perf!.id]))
    }
  })

  it("②超 20 条按 updatedAt 降序截前 20 条（最旧的被截掉）", async () => {
    const now = Date.now()
    const inserted = await Promise.all(
      Array.from({ length: 25 }, (_, i) => i).map((i) =>
        getDb()
          .insert(libraryItems)
          .values({ userId: userA, category: "personnel", title: `批量-${i}`, updatedAt: new Date(now - i * 1000) }) // i 越大越旧
          .returning(),
      ),
    )
    const ids = inserted.map((rows) => rows[0]!.id)

    try {
      const result = await libraryRefsRunInput(userA)
      const titles = result.library_refs?.personnel.map((x) => x.title) ?? []
      expect(titles.length).toBe(20)
      expect(titles).toEqual(Array.from({ length: 20 }, (_, i) => `批量-${i}`)) // 最新 20 条，降序排列
      expect(titles).not.toContain("批量-24") // 最旧 5 条（20~24）被截掉
    } finally {
      await getDb().delete(libraryItems).where(inArray(libraryItems.id, ids))
    }
  })

  it("③人员/业绩均无条目 → 不下发 library_refs 键", async () => {
    const result = await libraryRefsRunInput(userA)
    expect(result.library_refs).toBeUndefined()
    expect("library_refs" in result).toBe(false)
  })

  it("⑦tags 有值才带键（录入提示曾录了也不被下发，用户写了白写——补上这一路）", async () => {
    const [p] = await getDb()
      .insert(libraryItems)
      .values({ userId: userA, category: "personnel", title: "赵六", tags: ["PMP", "高级工程师"] })
      .returning()

    try {
      const result = await libraryRefsRunInput(userA)
      const item = result.library_refs?.personnel.find((x) => x.title === "赵六")
      expect(item).toEqual({ title: "赵六", tags: ["PMP", "高级工程师"] }) // 无 meta/fields/body 键，与 fields 同款「有值才带键」
    } finally {
      await getDb().delete(libraryItems).where(eq(libraryItems.id, p!.id))
    }
  })
})

describe("credentials 附件透传 ocrText", () => {
  it("④附件带 ocrText → images 元素透传该字段；无 ocrText 的附件该键缺省", async () => {
    const [imgWithOcr] = await getDb()
      .insert(projectFiles)
      .values({
        userId: userA,
        bucket: "bidsaas",
        key: `uploads/${userA}/${crypto.randomUUID()}/证书1.png`,
        filename: "证书1.png",
        contentType: "image/png",
        size: 1,
        status: "uploaded",
      })
      .returning()
    const [imgNoOcr] = await getDb()
      .insert(projectFiles)
      .values({
        userId: userA,
        bucket: "bidsaas",
        key: `uploads/${userA}/${crypto.randomUUID()}/证书2.png`,
        filename: "证书2.png",
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
        title: "ocrText 透传测试",
        attachments: [
          { fileId: imgWithOcr!.id, name: "证书1.png", ocrText: "统一社会信用代码91xx" },
          { fileId: imgNoOcr!.id, name: "证书2.png" },
        ],
      })
      .returning()

    try {
      const credentials = await credentialsRunInput(userA)
      expect(credentials).toEqual([
        {
          title: "ocrText 透传测试",
          images: [
            { fileId: imgWithOcr!.id, key: imgWithOcr!.key, name: "证书1.png", ocrText: "统一社会信用代码91xx" },
            { fileId: imgNoOcr!.id, key: imgNoOcr!.key, name: "证书2.png" },
          ],
        },
      ])
      expect("ocrText" in credentials![0]!.images[1]!).toBe(false) // 无 ocrText 的附件不应凭空长出该键
    } finally {
      await getDb().delete(libraryItems).where(eq(libraryItems.id, item!.id))
    }
  })
})

describe("libraryRefsRunInput body 超预算截断（Task 2 遗留，终审顺手条）", () => {
  it("⑥body 超 3000 字 → 传输前先截断——agent 侧 _LIBRARY_REF_BLOCK_CHARS 反正要按同一预算砍，别把注定被砍的字节传一遍", async () => {
    const longBody = "详".repeat(4000)
    const [p] = await getDb()
      .insert(libraryItems)
      .values({ userId: userA, category: "personnel", title: "王五", body: longBody })
      .returning()

    try {
      const result = await libraryRefsRunInput(userA)
      const body = result.library_refs?.personnel.find((x) => x.title === "王五")?.body
      expect(body?.length).toBe(3000)
      expect(body).toBe(longBody.slice(0, 3000))
    } finally {
      await getDb().delete(libraryItems).where(eq(libraryItems.id, p!.id))
    }
  })
})

describe("下发时机：content 步下发 library_refs，export 步不下发", () => {
  it("⑥常用文本里标题写着企业信息的条目 → content 步带 company；别的常用文本不带", async () => {
    const [company] = await getDb()
      .insert(libraryItems)
      .values({ userId: userA, category: "text", title: "企业信息",
                fields: [{ label: "单位名称", value: "上海安几科技有限公司" }] })
      .returning()
    // 常用文本里还放着技术方案片段等大段文字，只有标题命中的才下发，否则白占单章预算
    const [noise] = await getDb()
      .insert(libraryItems)
      .values({ userId: userA, category: "text", title: "技术方案常用段落", body: "零信任架构概述……" })
      .returning()

    try {
      const { id } = await createProject(tokenA, keyA)
      await runToExport(id, tokenA)
      expect(runInputsByStep.content?.library_refs?.company).toEqual([
        { title: "企业信息", fields: [{ label: "单位名称", value: "上海安几科技有限公司" }] },
      ])
    } finally {
      await getDb().delete(libraryItems).where(inArray(libraryItems.id, [company!.id, noise!.id]))
    }
  })

  it("⑤有人员/业绩条目 → content 步 run_input.library_refs 非空；export 步 run_input 无该键", async () => {
    const [p] = await getDb()
      .insert(libraryItems)
      .values({ userId: userA, category: "personnel", title: "李四", meta: "技术负责人" })
      .returning()
    const [perf] = await getDb()
      .insert(libraryItems)
      .values({ userId: userA, category: "performance", title: "XX 智能化改造工程", meta: "2023 年" })
      .returning()

    try {
      const { id } = await createProject(tokenA, keyA)
      await runToExport(id, tokenA)

      expect(runInputsByStep.content?.library_refs).toEqual({
        personnel: [{ title: "李四", meta: "技术负责人" }],
        performance: [{ title: "XX 智能化改造工程", meta: "2023 年" }],
      })
      // 没录企业信息 → 不带 company 键：正文缓存键吃的就是这份简报，凭空多一个空数组
      // 会让全库断点缓存失效（上面的 toEqual 已经守住形状，这里点明意图）
      expect(runInputsByStep.content?.library_refs).not.toHaveProperty("company")
      expect(runInputsByStep.export?.library_refs).toBeUndefined()
      expect(runInputsByStep.export?.credentials).toBeUndefined() // 回归：export 步仍不带 credentials（Task 1 既有约束未被本任务破坏）
    } finally {
      await getDb().delete(libraryItems).where(inArray(libraryItems.id, [p!.id, perf!.id]))
    }
  })
})
