import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import { projectRoutes, type ProjectDeps } from "../src/routes/projects"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, bidProjects, projectSteps, creditTransactions } from "../src/db/schema"
import { grant, hold, getBalance } from "../src/services/credits"
import { seedConfigs } from "../src/services/config"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

// 连远程 DB（跑法：./test-on-mbp.sh test/stuck-steps.test.ts）。
// 每个用例含自愈全链路（撞索引→事务收尾→真账本退还→重试插入→SSE 收尾）约 35 次远程往返，
// 隧道抖动时 20s 会超时——超时后 bun 提前跑下个用例，共享余额断言互相踩踏（假失败），故给足余量。
setDefaultTimeout(Math.max(TEST_TIMEOUT_MS, 120_000))

// 卡死 running 占位行的惰性自愈（请求路径，无 Cron）：
// POST steps 撞 running 唯一索引时，死行（超 10 分钟）当场置 failed + 退还预扣，本次请求照常放行。
// 计费/agent 依赖 mock（新请求不动真钱），但被卡行的 hold 走真账本——退钱断言查真流水/真余额。

let token = ""
let userId = ""
const MIN = 60_000

const mockDeps: Partial<ProjectDeps> = {
  preDeduct: async (_userId, op) => ({ ok: true, holdId: `hold-${op}`, hold: 10 }),
  settle: async (_ref, _holdId, actualCost) => actualCost,
  settleContent: async (_ref, _holdId, heldAmount) => heldAmount,
  settleFailed: async () => {},
  createRun: async () => ({ run_id: crypto.randomUUID() }),
  relayStream: async function* () {
    yield "data: 进度\n\n"
  },
  getRun: async () => ({ status: "succeeded", result: { categories: [] } }),
}

const app = new Hono()
app.route("/api/projects", projectRoutes(mockDeps))
const auth = () => ({ Authorization: `Bearer ${token}`, "content-type": "application/json" })

beforeAll(async () => {
  await seedConfigs()
  const r = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  token = r.token
  userId = r.user.id
  await grant(userId, 500, { idempotencyKey: `stuck-grant-${userId}` })
})

afterAll(async () => {
  await getDb().delete(users).where(eq(users.id, userId)) // 项目/步/流水随 user 级联删
  await closeDb()
})

/** 造一个 draft 项目 + 一条回拨 created_at 的 running 占位行（模拟收尾没执行的卡死行）。 */
async function makeStuckProject(ageMs: number) {
  const [p] = await getDb()
    .insert(bidProjects)
    .values({ userId, threadId: `proj-${crypto.randomUUID()}`, tenderFileKey: "uploads/t/x.pdf" })
    .returning()
  const [s] = await getDb()
    .insert(projectSteps)
    .values({ projectId: p!.id, step: "read", status: "running", createdAt: new Date(Date.now() - ageMs) })
    .returning()
  return { projectId: p!.id, stepId: s!.id }
}

/** 与 projects.ts preDeduct 同约定的真账本预扣：ref=占位行 id，幂等键 hold:<stepId>。 */
const holdForStep = (stepId: string) => hold(userId, "read", { ref: stepId, idempotencyKey: `hold:${stepId}` })

const stepRow = async (id: string) => (await getDb().select().from(projectSteps).where(eq(projectSteps.id, id)))[0]!
const releasesOf = (holdId: string) =>
  getDb()
    .select()
    .from(creditTransactions)
    .where(and(eq(creditTransactions.type, "release"), eq(creditTransactions.ref, holdId)))

describe("卡死 running 步惰性自愈（POST steps 撞 409 时当场收尾 + 退钱）", () => {
  it("① 15 分钟前的卡死行 + 真 hold → 新 POST 同步骤：旧行 failed、hold 退还、新请求正常开跑", async () => {
    const balance0 = await getBalance(userId)
    const { projectId, stepId } = await makeStuckProject(15 * MIN)
    const { holdId, amount } = await holdForStep(stepId)
    expect(await getBalance(userId)).toBe(balance0 - amount) // 预扣已冻结

    const res = await app.request(`/api/projects/${projectId}/steps/read`, { method: "POST", headers: auth() })
    expect(res.status).toBe(200)
    const sse = await res.text()
    expect(sse).toContain("event: step.done") // 新请求正常走完（mock run succeeded）

    expect((await stepRow(stepId)).status).toBe("failed") // 旧卡死行被收尾
    expect(await getBalance(userId)).toBe(balance0) // 预扣全额退还
    expect(await releasesOf(holdId)).toHaveLength(1)
    // 新占位行已由本次请求落成 done（计费走 mock，不再动真账本）
    const rows = await getDb()
      .select()
      .from(projectSteps)
      .where(and(eq(projectSteps.projectId, projectId), eq(projectSteps.step, "read"), eq(projectSteps.status, "done")))
    expect(rows).toHaveLength(1)
  })

  it("② 新鲜 running 行（2 分钟）→ 如实 409 step_already_running，不动行不动钱", async () => {
    const { projectId, stepId } = await makeStuckProject(2 * MIN)
    const { holdId } = await holdForStep(stepId)

    const res = await app.request(`/api/projects/${projectId}/steps/read`, { method: "POST", headers: auth() })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe("step_already_running")
    expect((await stepRow(stepId)).status).toBe("running") // 活行不误杀
    expect(await releasesOf(holdId)).toHaveLength(0) // 分文未退
  })

  it("③ 并发两个 POST 同撞卡死行 → 只退一次钱（条件更新唯一了结点）", async () => {
    const balance0 = await getBalance(userId)
    const { projectId, stepId } = await makeStuckProject(20 * MIN)
    const { holdId } = await holdForStep(stepId)

    const [r1, r2] = await Promise.all([
      app.request(`/api/projects/${projectId}/steps/read`, { method: "POST", headers: auth() }),
      app.request(`/api/projects/${projectId}/steps/read`, { method: "POST", headers: auth() }),
    ])
    await Promise.all([r1.text(), r2.text()]) // 耗尽 SSE，确保两请求都收尾
    expect([r1.status, r2.status]).toContain(200) // 至少一个放行（另一个 200 或 409 均合法）
    for (const st of [r1.status, r2.status]) expect([200, 409]).toContain(st)

    expect((await stepRow(stepId)).status).toBe("failed")
    expect(await releasesOf(holdId)).toHaveLength(1) // 绝不双退
    expect(await getBalance(userId)).toBe(balance0) // 净退还恰好一份预扣
  })

  it("④ 卡死行无 hold（预扣前挂的）→ 也能收尾不炸，新请求照常放行", async () => {
    const balance0 = await getBalance(userId)
    const { projectId, stepId } = await makeStuckProject(15 * MIN)

    const res = await app.request(`/api/projects/${projectId}/steps/read`, { method: "POST", headers: auth() })
    expect(res.status).toBe(200)
    await res.text()
    expect((await stepRow(stepId)).status).toBe("failed")
    expect(await getBalance(userId)).toBe(balance0) // 没有 hold，余额不变
  })
})
