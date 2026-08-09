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
  const a = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => "ok" as const)
  tokenA = a.token
  userA = a.user.id
  const b = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => "ok" as const)
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

  it("spec321：章带 structureRef → toSnake 落库为 structure_ref，GET 读回 structureRef（往返不丢字段）", async () => {
    const res = await patch(projectId, "outline", { result: { chapters: [chapter({ structureRef: "s1" })] } }, tokenA)
    expect(res.status).toBe(200)

    // 落库为 snake 原样
    const [row] = await getDb()
      .select()
      .from(projectSteps)
      .where(and(eq(projectSteps.projectId, projectId), eq(projectSteps.step, "outline")))
    expect(JSON.stringify(row!.result)).toContain('"structure_ref":"s1"')

    // GET 读回 camel，字段完整往返
    const detail = await app.request(`/api/projects/${projectId}`, { headers: { Authorization: `Bearer ${tokenA}` } })
    const body = (await detail.json()) as { steps: Array<{ step: string; result: unknown }> }
    const outline = body.steps.find((s) => s.step === "outline")
    expect(JSON.stringify(outline!.result)).toContain('"structureRef":"s1"')
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
      // 述标结构性升级：新版式的坏形状同样挡在入口——留到导出阶段才炸就晚了
      ["present", deck({ slides: [{ id: "s-1", title: "x", kind: "content", layout: "waterfall" }] })], // layout 越界
      ["present", deck({ slides: [{ id: "s-1", title: "x", kind: "content", layout: "chart",
        chart: { type: "pie", categories: ["A", "B", "C"], series: [{ name: "n", values: [1, 2] }] } }] })], // values 与 categories 不等长
      ["present", deck({ slides: [{ id: "s-1", title: "x", kind: "content", layout: "chart",
        chart: { type: "pie", categories: ["A"], series: [{ name: "n1", values: [1] }, { name: "n2", values: [2] }] } }] })], // 饼图多系列
      ["present", deck({ slides: [{ id: "s-1", title: "x", kind: "content", layout: "comparison",
        stats: [{ value: "a", label: "1" }, { value: "b", label: "2" }, { value: "c", label: "3" }] }] })], // stats 超 2 张
      // 空串卡片会让渲染层取不到 run（导出崩，且是付费步之后才崩）；空数组则静默退化成普通要点页
      ["present", deck({ slides: [{ id: "s-1", title: "x", kind: "content", layout: "comparison",
        bullets: ["要点"], stats: [{ value: "", label: "" }] }] })], // 卡片内容不能为空串
      ["present", deck({ slides: [{ id: "s-1", title: "x", kind: "content", layout: "comparison",
        bullets: ["要点"], stats: [] }] })], // comparison 至少 1 张卡片
      ["present", deck({ slides: [{ id: "s-1", title: "x", kind: "content", layout: "chart" }] })], // chart 版式缺 chart 数据
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

  it("present 步：section 分隔页与图表/对比版式的数据能存进去（保存不能把它们吞掉）", async () => {
    // 生产隐患：编辑器「保存述标」是整份 slides 回写。若 kind 枚举缺 section，任何含分隔页的述标
    // 一点保存就 400；若 layout/chart/stats 不在 schema 里，一次保存就把图表页降级成空白 bullets 页
    // （导出的 PPT 里图表凭空消失，用户只会觉得"图表怎么没了"）。
    const edited = deck({
      slides: [
        { id: "s-0", title: "封面", kind: "cover" },
        { id: "s-1", title: "技术方案", kind: "section", bullets: ["核心能力"] },
        { id: "s-2", title: "团队构成", kind: "content", layout: "chart", scoring: "团队 20 分",
          chart: { type: "pie", categories: ["高级", "中级"], series: [{ name: "人数", values: [3, 6] }] } },
        { id: "s-3", title: "业绩对比", kind: "content", layout: "comparison", bullets: ["近三年 5 个项目"],
          stats: [{ value: "72 小时", label: "较招标要求提前完成" }] },
      ],
    })
    const res = await patch(projectId2, "present", { result: edited }, tokenA)
    expect(res.status).toBe(200)
    const [row] = await getDb()
      .select()
      .from(projectSteps)
      .where(and(eq(projectSteps.projectId, projectId2), eq(projectSteps.step, "present")))
    const stored = row!.result as { slides: Array<Record<string, unknown>> }
    expect(stored.slides[1]!.kind).toBe("section")
    expect(stored.slides[2]!.layout).toBe("chart")
    expect(stored.slides[2]!.chart).toBeTruthy()      // 图表数据没被吞
    expect(stored.slides[3]!.stats).toHaveLength(1)   // 数字卡片没被吞
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

// 终审 wave2：两处整列覆盖保全——present 编辑保存必须把存量 result.artifacts（executor 合并进来
// 的真实渲染 pptx+previews）携带过去，否则一次保存就把它抹掉；outline 保存时若存量行已有
// sys-creds 系统章而入参树（陈旧标签页）没带，服务端把系统章字面量补回。
describe("PATCH /api/projects/:id/steps/:step —— 整列覆盖两处保全", () => {
  let projectIdPresent = ""
  let projectIdOutline = ""
  const ARTIFACTS = { pptx: "artifacts/t/present.pptx", previews: ["artifacts/t/preview-01.png", "artifacts/t/preview-02.png"] }
  const SYS_CREDS_CHAPTER = { id: "sys-creds", no: "附录", title: "资格证明文件", group: "business", system: true, sourced: false, items: [] }

  beforeAll(async () => {
    const [p1] = await getDb()
      .insert(bidProjects)
      .values({ userId: userA, threadId: `proj-${crypto.randomUUID()}`, currentStep: "export", status: "running" })
      .returning()
    projectIdPresent = p1!.id
    // present 步 result：executor 已把真实渲染产物（pptx key + 逐页预览图）合并进 artifacts 键
    await getDb().insert(projectSteps).values({
      projectId: projectIdPresent, step: "present", status: "done",
      result: { ...deck(), artifacts: ARTIFACTS },
    })

    const [p2] = await getDb()
      .insert(bidProjects)
      .values({ userId: userA, threadId: `proj-${crypto.randomUUID()}`, currentStep: "export", status: "running" })
      .returning()
    projectIdOutline = p2!.id
    // outline 步 result：content 收尾已追加 sys-creds 系统章；模拟陈旧标签页——PATCH 入参树里没有它
    await getDb().insert(projectSteps).values({
      projectId: projectIdOutline, step: "outline", status: "done",
      result: { chapters: [{ id: "ch-1", no: "第一章", title: "原提纲标题", group: "tech", items: [] }, SYS_CREDS_CHAPTER] },
    })
  })

  it("present 编辑保存（改标题/时长/幻灯片）后，result.artifacts（pptx+previews）仍在，不被整份覆写抹掉", async () => {
    const edited = deck({ title: "编辑后的述标主题", duration: 20 })
    const res = await patch(projectIdPresent, "present", { result: edited }, tokenA)
    expect(res.status).toBe(200)

    const [row] = await getDb()
      .select()
      .from(projectSteps)
      .where(and(eq(projectSteps.projectId, projectIdPresent), eq(projectSteps.step, "present")))
    const stored = row!.result as Record<string, unknown>
    expect(stored.title).toBe("编辑后的述标主题") // 编辑确实生效
    expect(stored.artifacts).toEqual(ARTIFACTS) // 存量 artifacts 没被抹掉
  })

  it("陈旧标签页覆盖 outline（入参树不含 sys-creds）→ 保存后 sys-creds 系统章仍在", async () => {
    // 陈旧标签页只带了它加载时看到的那一章，不知道 content 收尾后追加的系统章
    const staleTree = { chapters: [chapter({ id: "ch-1", title: "重命名后的标题" })] }
    const res = await patch(projectIdOutline, "outline", { result: staleTree }, tokenA)
    expect(res.status).toBe(200)

    const [row] = await getDb()
      .select()
      .from(projectSteps)
      .where(and(eq(projectSteps.projectId, projectIdOutline), eq(projectSteps.step, "outline")))
    const chapters = (row!.result as { chapters: { id: string; title?: string }[] }).chapters
    expect(chapters.find((c) => c.id === "ch-1")?.title).toBe("重命名后的标题") // 编辑确实生效
    expect(chapters.some((c) => c.id === "sys-creds")).toBe(true) // 系统章被服务端补回，没被陈旧覆盖丢掉
  })
})
