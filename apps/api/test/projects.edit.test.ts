import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq, inArray, and } from "drizzle-orm"
import { Hono } from "hono"
import { projectRoutes } from "../src/routes/projects"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, bidProjects, projectSteps } from "../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连真库

// PATCH /api/projects/:id/steps/:step 编辑回写（spec315a 契约 1）：
// 属主隔离 / 步未 done 404 / camel→snake 落库（content 例外原样）/ GET 读回 / 非法 step 400 / 坏形状 400
const app = new Hono()
app.route("/api/projects", projectRoutes())

let tokenA = ""
let userA = ""
let tokenB = ""
let userB = ""
let projectId = ""
let projectId2 = "" // content/present 有 done 行的项目（按步结构校验用例）

// 合法提纲章（对齐 agent Outline 必填：id/no/title/group/items）
const chapter = (over: Record<string, unknown> = {}) => ({
  id: "ch-1",
  no: "第一章",
  title: "编辑后的标题",
  group: "tech",
  items: [{ id: "i1", label: "1.1 需求理解", clauseIds: ["sec-2-c3"], isNew: false }],
  ...over,
})

// 合法 deck（对齐 agent DeckSpec 必填：title/duration/template/slides/qa）
const deck = (over: Record<string, unknown> = {}) => ({
  title: "述标主题",
  duration: 15,
  template: "blue",
  slides: [{ id: "s-1", title: "封面", kind: "cover" }],
  qa: [],
  ...over,
})

beforeAll(async () => {
  const a = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  tokenA = a.token
  userA = a.user.id
  const b = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  tokenB = b.token
  userB = b.user.id

  // A 的项目：outline 步 done（snake 原样存），content 步只有 failed 行（不可编辑）
  const [p] = await getDb()
    .insert(bidProjects)
    .values({ userId: userA, threadId: `proj-${crypto.randomUUID()}`, status: "running", currentStep: "content" })
    .returning()
  projectId = p!.id
  await getDb().insert(projectSteps).values({
    projectId,
    step: "outline",
    status: "done",
    result: { chapters: [{ id: "ch-1", chapter_title: "原提纲标题", clause_ids: ["sec-1-c1"] }] },
  })
  await getDb().insert(projectSteps).values({ projectId, step: "content", status: "failed" })

  // A 的第二个项目：content/present 都 done（结构校验 + content 键原样用例）
  const [p2] = await getDb()
    .insert(bidProjects)
    .values({ userId: userA, threadId: `proj-${crypto.randomUUID()}`, status: "running", currentStep: "export" })
    .returning()
  projectId2 = p2!.id
  await getDb().insert(projectSteps).values({
    projectId: projectId2,
    step: "content",
    status: "done",
    result: { ch_1: "<p>旧正文</p>" },
  })
  await getDb().insert(projectSteps).values({ projectId: projectId2, step: "present", status: "done", result: deck() })
})

afterAll(async () => {
  await getDb().delete(users).where(inArray(users.id, [userA, userB])) // 项目/步随 user 级联删
  await closeDb()
})

const patch = (id: string, step: string, body: unknown, token: string) =>
  app.request(`/api/projects/${id}/steps/${step}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })

describe("PATCH /api/projects/:id/steps/:step 编辑回写", () => {
  it("他人项目 → 404（属主隔离，不泄露存在性）", async () => {
    const res = await patch(projectId, "outline", { result: { chapters: [] } }, tokenB)
    expect(res.status).toBe(404)
  })

  it("step 无 done 行 → 404 step_not_done（failed 行不算）", async () => {
    const res = await patch(projectId, "content", { result: { "ch-1": "<p>x</p>" } }, tokenA)
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toBe("step_not_done")
  })

  it("成功：camel 请求体 toSnake 落库，GET /:id 读回编辑后值（camel）", async () => {
    const res = await patch(projectId, "outline", { result: { chapters: [chapter()] } }, tokenA)
    expect(res.status).toBe(200)
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: true })

    // 落库为 snake 原样（DB 与 agent 契约）
    const [row] = await getDb()
      .select()
      .from(projectSteps)
      .where(and(eq(projectSteps.projectId, projectId), eq(projectSteps.step, "outline")))
    expect(JSON.stringify(row!.result)).toContain("clause_ids")
    expect(JSON.stringify(row!.result)).toContain("编辑后的标题")

    // GET 读回 camel（前端直接复用原型类型）
    const detail = await app.request(`/api/projects/${projectId}`, { headers: { Authorization: `Bearer ${tokenA}` } })
    const body = (await detail.json()) as { steps: Array<{ step: string; result: unknown }> }
    const outline = body.steps.find((s) => s.step === "outline")
    expect(JSON.stringify(outline!.result)).toContain('"title":"编辑后的标题"')
    expect(JSON.stringify(outline!.result)).toContain('"clauseIds":["sec-2-c3"]')
  })

  it("content 步：章 id 键含下划线/大写 → 原样落库、GET 原样读回（不做大小写转换）", async () => {
    const edited = { ch_1: "<p>编辑后的正文</p>", T2_Chapter: "<p>大写键章节</p>" }
    const res = await patch(projectId2, "content", { result: edited }, tokenA)
    expect(res.status).toBe(200)

    const [row] = await getDb()
      .select()
      .from(projectSteps)
      .where(and(eq(projectSteps.projectId, projectId2), eq(projectSteps.step, "content")))
    expect(row!.result).toEqual(edited) // 落库原样，ch_1 没被 toSnake/toCamel 折腾

    const detail = await app.request(`/api/projects/${projectId2}`, { headers: { Authorization: `Bearer ${tokenA}` } })
    const body = (await detail.json()) as { steps: Array<{ step: string; result: unknown }> }
    const content = body.steps.find((s) => s.step === "content")
    expect(content!.result).toEqual(edited) // 往返不变形（toCamel 会把 ch_1 转坏成 ch1）
  })

  it("按步结构校验：坏形状 → 400 invalid_result，不落库", async () => {
    const cases: Array<[step: string, result: unknown]> = [
      ["content", { ch_1: 123 }], // 值必须全是字符串 html
      ["outline", { chapters: [{ id: "ch-1" }] }], // 缺 no/title/group/items
      ["outline", { chapters: [chapter({ group: "legal" })] }], // group 越界
      ["present", deck({ duration: 12 })], // duration 只能 10/15/20
      ["present", deck({ template: "pink" })], // template 只能 blue/tech/gov
      ["present", deck({ slides: [] })], // slides 不能为空
      ["present", deck({ slides: [{ id: "s-1", title: "x", kind: "intro" }] })], // kind 越界
    ]
    for (const [step, result] of cases) {
      const res = await patch(projectId2, step, { result }, tokenA)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe("invalid_result")
    }
    // 校验挡在落库前：present 行仍是 beforeAll 的原值
    const [row] = await getDb()
      .select()
      .from(projectSteps)
      .where(and(eq(projectSteps.projectId, projectId2), eq(projectSteps.step, "present")))
    expect(row!.result).toEqual(deck())
  })

  it("present 步：合法 deck（宽进，未知键保留）→ 200 落库", async () => {
    const edited = deck({ duration: 20, slides: [{ id: "s-1", title: "封面", kind: "cover", bullets: ["要点"] }] })
    const res = await patch(projectId2, "present", { result: edited }, tokenA)
    expect(res.status).toBe(200)
    const [row] = await getDb()
      .select()
      .from(projectSteps)
      .where(and(eq(projectSteps.projectId, projectId2), eq(projectSteps.step, "present")))
    expect(JSON.stringify(row!.result)).toContain('"要点"') // passthrough：未知键不被校验吞掉
    expect((row!.result as { duration: number }).duration).toBe(20)
  })

  it("非法 step（read/export/未知）→ 400 bad_step", async () => {
    for (const step of ["read", "export", "nope"]) {
      const res = await patch(projectId, step, { result: { a: 1 } }, tokenA)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe("bad_step")
    }
  })

  it("非法 body（空对象/缺 result/非对象）→ 400；非 uuid 项目 → 404", async () => {
    for (const body of [{ result: {} }, {}, { result: "x" }]) {
      const res = await patch(projectId, "outline", body, tokenA)
      expect(res.status).toBe(400)
    }
    const res = await patch("not-a-uuid", "outline", { result: { a: 1 } }, tokenA)
    expect(res.status).toBe(404)
  })
})
