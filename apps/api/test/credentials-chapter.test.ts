import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { and, eq, inArray } from "drizzle-orm"
import { Hono } from "hono"
import { projectRoutes, type ProjectDeps } from "../src/routes/projects"
import { finalizeStepSuccess } from "../src/services/step-finalize"
import { buildCredentialsChapterHtml } from "../src/services/credentials-chapter"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, bidProjects, projectSteps, projectFiles, libraryItems } from "../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB

// 2026-08-09 附录系统章节 Task 4：①content 收尾钩子把「资格证明文件」系统章同步进库里 outline
// result（编辑器/审查/导出读的是库存，不追加就只有 agent 图内 state 知道这章存在）；
// ②POST /:id/refresh-credentials-appendix：资料库改了资质条目之后，不必重新生成整本正文，
// 就能把附录章刷到最新（走既有单章 merge + markExportDirty 路径）。

let tokenA = ""
let userA = ""
let tokenB = ""
let userB = ""
let keyA = ""
let projectIdA = "" // 已跑到 content done、且 userA 名下有资质条目的项目
let pngFileIdA = "" // userA 唯一一条资质条目挂的图片附件 fileId（export-preview credential_file_ids 断言用）

const STEP_RESULTS: Record<string, unknown> = {
  read: { categories: [], doc_sections: [] },
  outline: { chapters: [{ id: "ch-1", no: "一", title: "技术方案", group: "tech", items: [] }] },
  content: { "ch-1": "<p>正文</p>" },
}
let runStep = ""

const mockDeps: Partial<ProjectDeps> = {
  resolveStepHoldAmount: async (step: string) => (step === "content" ? 260 : undefined),
  preDeduct: async () => ({ ok: true, holdId: "hold-x", hold: 10 }),
  settle: async (_ref, _holdId, actualCost) => actualCost,
  settleContent: async (_ref, _holdId, heldAmount) => heldAmount,
  settleFailed: async () => {},
  createRun: async (opts) => {
    const input = opts.input as { step: string }
    runStep = input.step
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

const createProject = async (token: string, fileKey: string) => {
  const res = await app.request("/api/projects", { method: "POST", headers: auth(token), body: JSON.stringify({ fileKey }) })
  expect(res.status).toBe(200)
  return (await res.json()) as { id: string }
}

async function runSteps(projectId: string, token: string, steps: readonly string[]) {
  for (const step of steps) {
    const res = await app.request(`/api/projects/${projectId}/steps/${step}`, { method: "POST", headers: auth(token) })
    expect(res.status).toBe(200)
    await res.text()
  }
}

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

  // userA 资料库挂一条资质（营业执照.png）：refresh 端点的 200/outline 补章场景靠它。
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
  pngFileIdA = pngFile!.id
  await getDb()
    .insert(libraryItems)
    .values({ userId: userA, category: "qualification", title: "营业执照", attachments: [{ fileId: pngFile!.id, name: "营业执照.png" }] })

  const { id } = await createProject(tokenA, keyA)
  projectIdA = id
  await runSteps(projectIdA, tokenA, ["read", "outline", "content"])
})

afterAll(async () => {
  await getDb().delete(users).where(inArray(users.id, [userA, userB])) // 项目/文件/资料库随 user 级联删
  await closeDb()
})

// ---- Part 1：buildCredentialsChapterHtml（与 agent 侧 build_credentials_chapter 同形） ----

describe("buildCredentialsChapterHtml", () => {
  it("每条目一个 <h3>，逐图一个占位 <img>（三属性，无 src 无字节）", () => {
    const html = buildCredentialsChapterHtml([
      { title: "营业执照", images: [{ fileId: "f1", key: "k1", name: "n1" }] },
    ])
    expect(html).toContain("<h3>营业执照</h3>")
    expect(html).toContain('data-file-id="f1"')
    expect(html).toContain('data-object-key="k1"')
    expect(html).toContain('alt="营业执照"')
    expect(html).not.toContain("src=")
    expect(html).not.toContain("base64")
  })

  it("标题含 <>&\" 时转义，不破坏标签结构", () => {
    const html = buildCredentialsChapterHtml([{ title: '证照<A>&"B"', images: [] }])
    expect(html).toBe("<h3>证照&lt;A&gt;&amp;&quot;B&quot;</h3>")
  })

  it("空数组返回空串", () => {
    expect(buildCredentialsChapterHtml([])).toBe("")
  })

  // 终审 I-4：附录占位图 alt 从纯标题改为「标题|ocrText 截前 120 字」，与章内证照 post-pass
  // （services/cert-placement 等价的 agent 侧实现）同一套格式——两处占位图 alt 语义不该不一致。
  it("附件带 ocrText → alt 为「标题|ocrText 截前 120 字」", () => {
    const html = buildCredentialsChapterHtml([
      { title: "营业执照", images: [{ fileId: "f1", key: "k1", name: "n1", ocrText: "统一社会信用代码91xx" }] },
    ])
    expect(html).toContain('alt="营业执照|统一社会信用代码91xx"')
  })

  it("ocrText 超过 120 字 → 截断", () => {
    const long = "字".repeat(200)
    const html = buildCredentialsChapterHtml([
      { title: "资质证书", images: [{ fileId: "f1", key: "k1", name: "n1", ocrText: long }] },
    ])
    expect(html).toContain(`alt="资质证书|${long.slice(0, 120)}"`)
    expect(html).not.toContain(long) // 完整 200 字版本不该出现
  })

  it("无 ocrText → alt 退化为纯标题（与既有行为一致）", () => {
    const html = buildCredentialsChapterHtml([
      { title: "营业执照", images: [{ fileId: "f1", key: "k1", name: "n1" }] },
    ])
    expect(html).toContain('alt="营业执照"')
  })

  it("标题与 ocrText 都含需转义字符时，拼接后整串只转义一次（不产生二次转义）", () => {
    const html = buildCredentialsChapterHtml([
      { title: "A&B", images: [{ fileId: "f1", key: "k1", name: "n1", ocrText: 'C<D>' }] },
    ])
    expect(html).toContain('alt="A&amp;B|C&lt;D&gt;"')
    expect(html).not.toContain("&amp;amp;") // 二次转义的信号
  })
})

// ---- Part 2：content 收尾钩子（finalizeStepSuccess → outline 系统章同步） ----

/** 直接造一个「outline 已 done、content 待收尾」的项目，绕开完整六步 HTTP 流程——
 *  钩子本身只关心 finalizeStepSuccess 收到的 result，不需要真跑 agent。 */
async function makeContentReadyProject(outlineChapters: unknown[]) {
  const [p] = await getDb()
    .insert(bidProjects)
    .values({ userId: userA, threadId: `hook-${crypto.randomUUID()}`, tenderFileKey: keyA, currentStep: "content", status: "running" })
    .returning()
  await getDb()
    .insert(projectSteps)
    .values({ projectId: p!.id, step: "outline", status: "done", result: { chapters: outlineChapters } })
  const [contentRow] = await getDb()
    .insert(projectSteps)
    .values({ projectId: p!.id, step: "content", status: "running" })
    .returning()
  return { projectId: p!.id, contentStepId: contentRow!.id }
}

async function outlineChaptersOf(projectId: string): Promise<Record<string, unknown>[]> {
  const [row] = await getDb()
    .select({ result: projectSteps.result })
    .from(projectSteps)
    .where(and(eq(projectSteps.projectId, projectId), eq(projectSteps.step, "outline")))
  return ((row?.result as { chapters?: Record<string, unknown>[] } | null)?.chapters ?? [])
}

describe("content 收尾钩子：outline 系统章同步", () => {
  it("chapters 含 sys-creds 且库里 outline 无该 id → outline result 追加系统章字面量", async () => {
    const { projectId, contentStepId } = await makeContentReadyProject([
      { id: "ch-1", no: "一", title: "技术方案", group: "tech", items: [] },
    ])

    await finalizeStepSuccess({
      stepId: contentStepId, projectId, step: "content",
      result: { "ch-1": "<p>正文</p>", "sys-creds": "<h3>营业执照</h3>" },
      holdId: null, heldAmount: 0,
    })

    const chapters = await outlineChaptersOf(projectId)
    expect(chapters).toHaveLength(2)
    expect(chapters[1]).toEqual({
      id: "sys-creds", no: "附录", title: "资格证明文件", group: "business", system: true, sourced: false, items: [],
    })
  })

  it("outline 已含 sys-creds → 幂等，不重复追加", async () => {
    const { projectId, contentStepId } = await makeContentReadyProject([
      { id: "ch-1", no: "一", title: "技术方案", group: "tech", items: [] },
      { id: "sys-creds", no: "附录", title: "资格证明文件", group: "business", system: true, sourced: false, items: [] },
    ])

    await finalizeStepSuccess({
      stepId: contentStepId, projectId, step: "content",
      result: { "sys-creds": "<h3>重建后的新内容</h3>" }, // 评审语义：HTML 每次重建，但 outline 追加去重
      holdId: null, heldAmount: 0,
    })

    const chapters = await outlineChaptersOf(projectId)
    expect(chapters).toHaveLength(2) // 没有变成 3
  })

  it("content 产出不含 sys-creds（用户资料库无资质）→ outline 不动", async () => {
    const { projectId, contentStepId } = await makeContentReadyProject([
      { id: "ch-1", no: "一", title: "技术方案", group: "tech", items: [] },
    ])

    await finalizeStepSuccess({
      stepId: contentStepId, projectId, step: "content",
      result: { "ch-1": "<p>正文</p>" },
      holdId: null, heldAmount: 0,
    })

    const chapters = await outlineChaptersOf(projectId)
    expect(chapters).toHaveLength(1)
    expect(chapters.some((c) => c.id === "sys-creds")).toBe(false)
  })
})

// ---- Part 3：POST /:id/refresh-credentials-appendix ----

describe("POST /:id/refresh-credentials-appendix", () => {
  it("200：返回 html，content result 的 sys-creds 键更新（不覆盖其它章），export 置脏", async () => {
    // 先把脏标记清成「干净」的旧状态，才能验证刷新确实重新置脏了它（新项目默认就是脏的，
    // 不清一下这个断言测不出东西）。
    await getDb()
      .update(bidProjects)
      .set({ exportDirty: false, contentChangedAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(bidProjects.id, projectIdA))

    const res = await app.request(`/api/projects/${projectIdA}/refresh-credentials-appendix`, {
      method: "POST", headers: auth(tokenA),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { html: string }
    expect(body.html).toContain("<h3>营业执照</h3>")
    expect(body.html).toContain("data-file-id=")

    const [contentRow] = await getDb()
      .select({ result: projectSteps.result })
      .from(projectSteps)
      .where(and(eq(projectSteps.projectId, projectIdA), eq(projectSteps.step, "content"), eq(projectSteps.status, "done")))
    const result = contentRow!.result as Record<string, unknown>
    expect(result["sys-creds"]).toBe(body.html)
    expect(result["ch-1"]).toBe("<p>正文</p>") // 既有章节没被整份覆盖掉

    const [outlineRow] = await getDb()
      .select({ result: projectSteps.result })
      .from(projectSteps)
      .where(and(eq(projectSteps.projectId, projectIdA), eq(projectSteps.step, "outline"), eq(projectSteps.status, "done")))
    const outlineChapters = (outlineRow!.result as { chapters: { id: string }[] }).chapters
    expect(outlineChapters.some((c) => c.id === "sys-creds")).toBe(true) // outline 无则补章

    const [proj] = await getDb().select().from(bidProjects).where(eq(bidProjects.id, projectIdA))
    expect(proj!.exportDirty).toBe(true) // 置脏了
    expect(proj!.contentChangedAt!.getTime()).toBeGreaterThan(new Date("2020-01-01T00:00:00Z").getTime())
  })

  it("重复刷新：资料库未变，重建 HTML 与库内现值逐字相同 → 不再置脏（终审 wave2，误伤修复）", async () => {
    // 上一条用例已把 sys-creds 刷成当前资料库状态对应的 HTML；库没再变过，这次刷新重建出的
    // HTML 理应逐字相同。此前无条件 markExportDirty，这种"手滑再点一次刷新"的空操作会让下次
    // 导出从免费变收费——先清脏标记，验证刷新后不该被重新置脏。
    await getDb()
      .update(bidProjects)
      .set({ exportDirty: false, contentChangedAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(bidProjects.id, projectIdA))

    const res = await app.request(`/api/projects/${projectIdA}/refresh-credentials-appendix`, {
      method: "POST", headers: auth(tokenA),
    })
    expect(res.status).toBe(200)

    const [proj] = await getDb().select().from(bidProjects).where(eq(bidProjects.id, projectIdA))
    expect(proj!.exportDirty).toBe(false) // 库没变 → 不该被置脏
    expect(proj!.contentChangedAt!.getTime()).toBe(new Date("2020-01-01T00:00:00Z").getTime()) // 也不该被推进
  })

  it("409 no_credentials：资料库无资质条目", async () => {
    const bKey = `uploads/${userB}/${crypto.randomUUID()}/招标文件.pdf`
    await getDb()
      .insert(projectFiles)
      .values({ userId: userB, bucket: "bidsaas", key: bKey, filename: "招标文件.pdf", contentType: "application/pdf", size: 1, status: "uploaded" })
    const { id } = await createProject(tokenB, bKey)

    const res = await app.request(`/api/projects/${id}/refresh-credentials-appendix`, { method: "POST", headers: auth(tokenB) })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe("no_credentials")
  })

  it("404：他人项目", async () => {
    const res = await app.request(`/api/projects/${projectIdA}/refresh-credentials-appendix`, { method: "POST", headers: auth(tokenB) })
    expect(res.status).toBe(404)
  })
})

// ---- Part 4：export-preview 顺带扩展的 credential_file_ids（Task 5 依赖） ----

describe("GET /:id/export-preview 的 credential_file_ids（Task 5 依赖）", () => {
  it("全部资质图片附件的 fileId 平铺（与既有 credentials 摘要字段并存）", async () => {
    const res = await app.request(`/api/projects/${projectIdA}/export-preview`, { headers: auth(tokenA) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { credential_file_ids: string[] }
    expect(body.credential_file_ids).toEqual([pngFileIdA])
  })
})
