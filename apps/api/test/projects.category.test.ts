import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import { Hono } from "hono"
import { projectRoutes, type ProjectDeps } from "../src/routes/projects"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, bidProjects, projectFiles, projectSteps, bidCategoryCorrections } from "../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB

// spec334 标书分类：PATCH /:id/category 三态（设置 / null 回落判定值 / 空数组明确不用）+
// run_input 下发有效值（read 步不含）+ 纠偏记录只在「判过且被改」时写 + slim 回有效值。

let tokenA = ""
let userA = ""
let tokenB = ""
let userB = ""

const STEP_RESULTS: Record<string, unknown> = {
  read: { categories: [], doc_sections: [] },
  outline: { chapters: [{ id: "ch-1", chapter_title: "技术方案", clause_ids: [] }] },
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
  const b = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  tokenB = b.token
  userB = b.user.id
})

afterAll(async () => {
  await getDb().delete(users).where(inArray(users.id, [userA, userB]))
  await closeDb()
})

const auth = (token: string) => ({ Authorization: `Bearer ${token}`, "content-type": "application/json" })

const createProject = async (token: string) => {
  const userId = token === tokenA ? userA : userB
  const key = `uploads/${userId}/${crypto.randomUUID()}/招标文件.pdf`
  await getDb()
    .insert(projectFiles)
    .values({ userId, bucket: "bidsaas", key, filename: "招标文件.pdf", contentType: "application/pdf", size: 1, status: "uploaded" })
  const res = await app.request("/api/projects", { method: "POST", headers: auth(token), body: JSON.stringify({ fileKey: key }) })
  const body = (await res.json()) as { id: string }
  return body.id
}

/** 造一条带判定值的读标 done 行——判定值是 agent 产的，测试里直接落库模拟。
 *  同时把项目推到「读标已完成」：否则项目停在 draft/read，后面跑 outline 会被 out_of_order 挡掉，
 *  断言读到的是上一个用例留下的 run_input（假绿/假红都可能）。 */
const seedDetected = async (projectId: string, value: string[], confidence = "high") => {
  await getDb().insert(projectSteps).values({
    projectId, step: "read", status: "done",
    result: { categories: [], bid_category: { value, confidence, reason: "r", evidence_clause_ids: [] } },
  })
  await getDb().update(bidProjects).set({ status: "running", currentStep: "outline" }).where(eq(bidProjects.id, projectId))
}

const patchCategory = (id: string, body: unknown, token: string) =>
  app.request(`/api/projects/${id}/category`, { method: "PATCH", headers: auth(token), body: JSON.stringify(body) })

describe("PATCH /api/projects/:id/category（spec334）", () => {
  it("设置：200 回写，GET 详情回读一致", async () => {
    const id = await createProject(tokenA)
    const res = await patchCategory(id, ["goods", "services"], tokenA)
    expect(res.status).toBe(200)
    expect((await res.json()) as { ok: boolean; bidCategory: unknown }).toEqual({ ok: true, bidCategory: ["goods", "services"] })

    const detail = await app.request(`/api/projects/${id}`, { headers: auth(tokenA) })
    const body = (await detail.json()) as { project: { bidCategory: unknown } }
    expect(body.project.bidCategory).toEqual(["goods", "services"])
  })

  it("三态：null 回落判定值，空数组表示明确不用分类", async () => {
    const id = await createProject(tokenA)
    await seedDetected(id, ["engineering"])

    // ① 没表态（null）⇒ 有效值回落判定值
    const slim1 = await app.request(`/api/projects/${id}?slim=1`, { headers: auth(tokenA) })
    expect(((await slim1.json()) as { effectiveCategory: unknown }).effectiveCategory).toEqual(["engineering"])

    // ② 明确不用（空数组）⇒ **不得再回落判定值**，否则用户永远关不掉
    expect((await patchCategory(id, [], tokenA)).status).toBe(200)
    const slim2 = await app.request(`/api/projects/${id}?slim=1`, { headers: auth(tokenA) })
    expect(((await slim2.json()) as { effectiveCategory: unknown }).effectiveCategory).toEqual([])

    // ③ 清除（null）⇒ 回到没表态，重新回落判定值
    expect((await patchCategory(id, null, tokenA)).status).toBe(200)
    const slim3 = await app.request(`/api/projects/${id}?slim=1`, { headers: auth(tokenA) })
    expect(((await slim3.json()) as { effectiveCategory: unknown }).effectiveCategory).toEqual(["engineering"])
  })

  it("去重截断与非法值：重复项去重，非法枚举/超长数组 400", async () => {
    const id = await createProject(tokenA)
    await patchCategory(id, ["goods", "goods"], tokenA)
    const [row] = await getDb().select().from(bidProjects).where(eq(bidProjects.id, id))
    expect(row?.bidCategory).toEqual(["goods"])

    expect((await patchCategory(id, ["建筑"], tokenA)).status).toBe(400)
    expect((await patchCategory(id, ["goods", "services", "engineering"], tokenA)).status).toBe(400)
  })

  it("属主隔离：他人项目 → 404，不改动原值", async () => {
    const id = await createProject(tokenA)
    await patchCategory(id, ["services"], tokenA)
    expect((await patchCategory(id, ["goods"], tokenB)).status).toBe(404)
    const [row] = await getDb().select().from(bidProjects).where(eq(bidProjects.id, id))
    expect(row?.bidCategory).toEqual(["services"])
  })
})

describe("纠偏样本（spec334）", () => {
  it("判过且被改 → 记一条；判得一样 → 不记", async () => {
    const id = await createProject(tokenA)
    await seedDetected(id, ["goods"])
    await patchCategory(id, ["services"], tokenA)
    let rows = await getDb().select().from(bidCategoryCorrections).where(eq(bidCategoryCorrections.projectId, id))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.detected).toEqual(["goods"])
    expect(rows[0]!.confirmed).toEqual(["services"])

    await patchCategory(id, ["goods"], tokenA) // 改回与判定一致 ⇒ 不是纠偏
    rows = await getDb().select().from(bidCategoryCorrections).where(eq(bidCategoryCorrections.projectId, id))
    expect(rows).toHaveLength(1)
  })

  it("**没判过时的用户选择一律不记**——那是覆盖率问题不是准确率问题", async () => {
    const id = await createProject(tokenA)
    await seedDetected(id, []) // 多包件/判据不足/调用失败三种情况判定值都是空
    await patchCategory(id, ["engineering"], tokenA)
    const rows = await getDb().select().from(bidCategoryCorrections).where(eq(bidCategoryCorrections.projectId, id))
    expect(rows).toHaveLength(0)
  })
})

describe("run_input 下发（spec334）", () => {
  // 步骤运行是 SSE：响应体必须消费掉，否则流没跑完、createRun 的入参断言会读到上一次的值
  const runStepFor = async (id: string, step: string, token: string) => {
    const res = await app.request(`/api/projects/${id}/steps/${step}`, { method: "POST", headers: auth(token) })
    await res.text()
    return res
  }

  it("read 步不带分类——判定正是在那一步产生的，带上去会把上一轮结论钉死", async () => {
    const id = await createProject(tokenA)
    await patchCategory(id, ["goods"], tokenA)
    await runStepFor(id, "read", tokenA)
    expect(lastRunInput.bid_category).toBeUndefined()
  })

  // 两个项目而不是同一个跑两次：跳步校验只放行「当前步」，同一项目跑完 outline 后
  // currentStep 已推到 content，再跑 outline 会 409，断言读到的就是上一次的残留值。
  it("未确认 ⇒ 下发判定值（默认生效，不等用户点）", async () => {
    const id = await createProject(tokenA)
    await seedDetected(id, ["services"])
    await runStepFor(id, "outline", tokenA)
    expect(lastRunInput.bid_category).toEqual(["services"])
  })

  it("确认后 ⇒ 下发确认值", async () => {
    const id = await createProject(tokenA)
    await seedDetected(id, ["services"])
    await patchCategory(id, ["engineering"], tokenA)
    await runStepFor(id, "outline", tokenA)
    expect(lastRunInput.bid_category).toEqual(["engineering"])
  })

  it("用户明确不用分类（空数组）⇒ run_input 不带该键，行为回到改动前", async () => {
    const id = await createProject(tokenA)
    await seedDetected(id, ["services"])
    await patchCategory(id, [], tokenA)
    await runStepFor(id, "outline", tokenA)
    expect(lastRunInput.bid_category).toBeUndefined()
  })
})
