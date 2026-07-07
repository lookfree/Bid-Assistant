import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { and, eq, inArray, isNull } from "drizzle-orm"
import { Hono } from "hono"
import { checklistRoutes } from "../src/routes/checklist"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, bidProjects, projectChecklists } from "../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连真库

// GET/PUT /api/checklist 审核表持久化（spec315b 契约 2）：
// 空读返回 {}、upsert 幂等（NULLS NOT DISTINCT 唯一约束）、属主隔离、projectId 空/非空两行独立、坏 status 400。

const app = new Hono()
app.route("/api/checklist", checklistRoutes())

let tokenA = ""
let userA = ""
let tokenB = ""
let userB = ""
let projectA = "" // A 的项目

beforeAll(async () => {
  const a = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  tokenA = a.token
  userA = a.user.id
  const b = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  tokenB = b.token
  userB = b.user.id
  const [p] = await getDb()
    .insert(bidProjects)
    .values({ userId: userA, threadId: `proj-${crypto.randomUUID()}` })
    .returning()
  projectA = p!.id
})

afterAll(async () => {
  await getDb().delete(users).where(inArray(users.id, [userA, userB])) // checklist 行随 user 级联删
  await closeDb()
})

const getChecklist = (token: string, projectId?: string) =>
  app.request(`/api/checklist${projectId !== undefined ? `?projectId=${projectId}` : ""}`, {
    headers: { Authorization: `Bearer ${token}` },
  })

const putChecklist = (token: string, body: unknown) =>
  app.request("/api/checklist", {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })

describe("GET/PUT /api/checklist 审核表持久化", () => {
  it("① 无行返回空对象（带与不带 projectId 都是 {items:{}}）", async () => {
    const r1 = await getChecklist(tokenA)
    expect(r1.status).toBe(200)
    expect(await r1.json()).toEqual({ items: {} })
    const r2 = await getChecklist(tokenA, projectA)
    expect(r2.status).toBe(200)
    expect(await r2.json()).toEqual({ items: {} })
  })

  it("② PUT upsert 幂等：同 (user, 空 projectId) 反复写只有一行，读到最后一次的值", async () => {
    expect((await putChecklist(tokenA, { items: { "q-1": { status: "pass" } } })).status).toBe(200)
    const items2 = { "q-1": { status: "risk", owner: "张三", note: "缺页" }, "q-2": { status: "pending" } }
    expect((await putChecklist(tokenA, { items: items2 })).status).toBe(200)
    expect(await (await getChecklist(tokenA)).json()).toEqual({ items: items2 })
    // 库里只有一行：第二次 PUT 命中 NULLS NOT DISTINCT 唯一约束走 DO UPDATE，而非重复插入
    const rows = await getDb()
      .select()
      .from(projectChecklists)
      .where(and(eq(projectChecklists.userId, userA), isNull(projectChecklists.projectId)))
    expect(rows.length).toBe(1)
  })

  it("③ projectId 空与非空是两行独立数据，互不覆盖", async () => {
    const projItems = { "p-1": { status: "pass", owner: "李四" } }
    expect((await putChecklist(tokenA, { projectId: projectA, items: projItems })).status).toBe(200)
    // 项目行读到项目值；用户级默认行（②写入的）不受影响
    expect(await (await getChecklist(tokenA, projectA)).json()).toEqual({ items: projItems })
    const defaultRow = (await (await getChecklist(tokenA)).json()) as { items: Record<string, unknown> }
    expect(defaultRow.items["q-1"]).toEqual({ status: "risk", owner: "张三", note: "缺页" })
    // 两行分立
    const rows = await getDb().select().from(projectChecklists).where(eq(projectChecklists.userId, userA))
    expect(rows.length).toBe(2)
  })

  it("④ 属主隔离：A 存的 B 读不到；B 读/写 A 的项目 404", async () => {
    expect(await (await getChecklist(tokenB)).json()).toEqual({ items: {} }) // B 的默认行为空
    const readTheirs = await getChecklist(tokenB, projectA)
    expect(readTheirs.status).toBe(404) // 他人项目与不存在同语义
    const writeTheirs = await putChecklist(tokenB, { projectId: projectA, items: { "x-1": { status: "pass" } } })
    expect(writeTheirs.status).toBe(404)
  })

  it("⑤ 坏输入：非法 status 400；items 非对象 400；GET 非 uuid projectId 404", async () => {
    const badStatus = await putChecklist(tokenA, { items: { "q-1": { status: "done" } } })
    expect(badStatus.status).toBe(400)
    expect(((await badStatus.json()) as { error: string }).error).toBe("invalid_input")
    expect((await putChecklist(tokenA, { items: "oops" })).status).toBe(400)
    expect((await getChecklist(tokenA, "not-a-uuid")).status).toBe(404)
    // 坏写没有污染已存数据
    const after = (await (await getChecklist(tokenA)).json()) as { items: Record<string, unknown> }
    expect(after.items["q-1"]).toEqual({ status: "risk", owner: "张三", note: "缺页" })
  })

  it("⑥ 大小上限：键数 >500 / owner 或 note >200 字 → 400，边界内成功", async () => {
    // 键数封顶 500：501 个键拒收
    const tooMany: Record<string, { status: string }> = {}
    for (let i = 0; i < 501; i++) tooMany[`x-${i}`] = { status: "pass" }
    expect((await putChecklist(tokenA, { items: tooMany })).status).toBe(400)
    // 串长封顶 200：owner / note 超长拒收
    const long = "长".repeat(201)
    expect((await putChecklist(tokenA, { items: { "q-1": { status: "pass", owner: long } } })).status).toBe(400)
    expect((await putChecklist(tokenA, { items: { "q-1": { status: "pass", note: long } } })).status).toBe(400)
    // 边界内（200 字）照常成功
    const ok = { "q-9": { status: "pass", owner: "边".repeat(200), note: "" } }
    expect((await putChecklist(tokenA, { items: ok })).status).toBe(200)
    // 坏写没有污染数据：上一次成功写入仍在
    const after = (await (await getChecklist(tokenA)).json()) as { items: Record<string, { owner: string }> }
    expect(after.items["q-9"]!.owner.length).toBe(200)
  })
})
