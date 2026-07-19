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

// 卡死 running 占位行的自愈（spec327 加固后）：
// POST steps 撞 running 唯一索引时按 agent run 真实终态对账——成功的收尾交付（409 step_already_done,
// 绝不重跑重扣）、失败/无 run 的置 failed + 退还预扣后放行本次请求、活着的如实 409。
// 计费/agent 依赖 mock（新请求不动真钱），但被卡行的 hold 走真账本——退/结断言查真流水/真余额。

let token = ""
let userId = ""
const MIN = 60_000

// 按 runId 定制 agent run 终态（缺省 succeeded：新建 run 的收尾用）
const runByld = new Map<string, { status: string; result?: unknown }>()

const mockDeps: Partial<ProjectDeps> = {
  preDeduct: async (_userId, op) => ({ ok: true, holdId: `hold-${op}`, hold: 10 }),
  settle: async (_ref, _holdId, actualCost) => actualCost,
  settleContent: async (_ref, _holdId, heldAmount) => heldAmount,
  settleFailed: async () => {},
  createRun: async () => ({ run_id: crypto.randomUUID() }),
  relayStream: async function* () {
    yield "data: 进度\n\n"
  },
  getRun: async (runId: string) =>
    (runByld.get(runId) ?? { status: "succeeded", result: { categories: [] } }) as Awaited<
      ReturnType<ProjectDeps["getRun"]>
    >,
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

/** 造一个 draft 项目 + 一条回拨 created_at 的 running 占位行（模拟收尾没执行的卡死行）。
 *  runId 给定时挂上（配合 runByld 定制该 run 的 agent 终态）。 */
async function makeStuckProject(ageMs: number, runId?: string) {
  const [p] = await getDb()
    .insert(bidProjects)
    .values({ userId, threadId: `proj-${crypto.randomUUID()}`, tenderFileKey: "uploads/t/x.pdf" })
    .returning()
  const [s] = await getDb()
    .insert(projectSteps)
    .values({
      projectId: p!.id, step: "read", status: "running",
      createdAt: new Date(Date.now() - ageMs), ...(runId ? { runId } : {}),
    })
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

  it("⑤ run 已成功而收尾被打断 → 对账收尾交付：done+结果落库+真结算+推进，409 且绝不重跑", async () => {
    const balance0 = await getBalance(userId)
    const runId = crypto.randomUUID()
    runByld.set(runId, { status: "succeeded", result: { categories: [{ k: "recovered" }] } })
    const { projectId, stepId } = await makeStuckProject(15 * MIN, runId)
    const { amount } = await holdForStep(stepId)

    const res = await app.request(`/api/projects/${projectId}/steps/read`, { method: "POST", headers: auth() })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe("step_already_done")

    const row = await stepRow(stepId)
    expect(row.status).toBe("done") // 成功结果被交付,不是被杀
    expect(row.result).toEqual({ categories: [{ k: "recovered" }] })
    expect(row.costPoints).toBe(amount) // 真账本足额结算
    expect(await getBalance(userId)).toBe(balance0 - amount) // 净扣一份,无退款
    const [p] = await getDb().select().from(bidProjects).where(eq(bidProjects.id, projectId))
    expect(p!.currentStep).toBe("outline") // 流程推进
    // 该步只有这一行:没有因重试冒出第二行(重复计费)
    const rows = await getDb()
      .select()
      .from(projectSteps)
      .where(and(eq(projectSteps.projectId, projectId), eq(projectSteps.step, "read")))
    expect(rows).toHaveLength(1)
  })

  it("⑥ run 仍在真跑（agent 说 running）→ 即便行龄 30 分钟也不误杀：如实 409 running", async () => {
    const runId = crypto.randomUUID()
    runByld.set(runId, { status: "running" })
    const { projectId, stepId } = await makeStuckProject(30 * MIN, runId)
    const { holdId } = await holdForStep(stepId)

    const res = await app.request(`/api/projects/${projectId}/steps/read`, { method: "POST", headers: auth() })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe("step_already_running")
    expect((await stepRow(stepId)).status).toBe("running") // 长任务不再被 10 分钟阈值冤杀
    expect(await releasesOf(holdId)).toHaveLength(0)
  })

  it("⑦ run 已失败 → 判死退款后放行新请求（行龄未超 10 分钟也一样,不用干等）", async () => {
    const balance0 = await getBalance(userId)
    const runId = crypto.randomUUID()
    runByld.set(runId, { status: "failed" })
    const { projectId, stepId } = await makeStuckProject(2 * MIN, runId)
    const { holdId } = await holdForStep(stepId)

    const res = await app.request(`/api/projects/${projectId}/steps/read`, { method: "POST", headers: auth() })
    expect(res.status).toBe(200)
    await res.text()
    expect((await stepRow(stepId)).status).toBe("failed")
    expect(await releasesOf(holdId)).toHaveLength(1) // 全额退还
    expect(await getBalance(userId)).toBe(balance0)
  })
})

describe("卡死步对账 Cron（sweepStuckSteps 直调）", () => {
  it("⑧ 一轮扫描:成功 run 收尾交付、失败 run 退款、活 run 放过", async () => {
    const balance0 = await getBalance(userId)
    const okRun = crypto.randomUUID()
    const deadRun = crypto.randomUUID()
    const liveRun = crypto.randomUUID()
    const ok = await makeStuckProject(20 * MIN, okRun)
    const dead = await makeStuckProject(20 * MIN, deadRun)
    const live = await makeStuckProject(20 * MIN, liveRun)
    const holdOk = await holdForStep(ok.stepId)
    await holdForStep(dead.stepId)
    await holdForStep(live.stepId)
    const probe = async (runId: string) =>
      runId === okRun
        ? { status: "succeeded", result: { categories: [] } }
        : runId === deadRun
          ? { status: "failed" }
          : { status: "running" }

    const { sweepStuckSteps } = await import("../src/services/step-finalize")
    const counts = await sweepStuckSteps(probe)
    expect(counts.recovered).toBeGreaterThanOrEqual(1)
    expect(counts.failed).toBeGreaterThanOrEqual(1)

    expect((await stepRow(ok.stepId)).status).toBe("done")
    expect((await stepRow(dead.stepId)).status).toBe("failed")
    expect((await stepRow(live.stepId)).status).toBe("running")
    // 净变化 = 只结算了成功那步（失败步退还、活步冻结中）
    expect(await getBalance(userId)).toBe(balance0 - holdOk.amount * 2) // ok 结算 + live 仍冻结
  })

  it("⑨ 半收尾修复:done 行挂着未了结 hold（翻转后结算前崩溃）被补齐——结算+推进,重放不重复扣", async () => {
    const balance0 = await getBalance(userId)
    const { projectId, stepId } = await makeStuckProject(1 * MIN)
    const { amount } = await holdForStep(stepId)
    // 模拟 finalize 翻转 done(带 result)后立刻崩溃:未结算、未写 costPoints、未推进
    await getDb()
      .update(projectSteps)
      .set({ status: "done", result: { categories: [] } })
      .where(eq(projectSteps.id, stepId))

    const { sweepStuckSteps } = await import("../src/services/step-finalize")
    const probe = async () => ({ status: "running" }) // 修复路径不依赖 agent
    const c1 = await sweepStuckSteps(probe)
    expect(c1.repaired).toBeGreaterThanOrEqual(1)

    const row = await stepRow(stepId)
    expect(row.costPoints).toBe(amount) // 已结算并落计费
    expect(await getBalance(userId)).toBe(balance0 - amount)
    const [p] = await getDb().select().from(bidProjects).where(eq(bidProjects.id, projectId))
    expect(p!.currentStep).toBe("outline") // 流程解卡:currentStep 补推进

    await sweepStuckSteps(probe) // 重放:行已带 costPoints,不再选中,余额不变
    expect(await getBalance(userId)).toBe(balance0 - amount)
  })
})
