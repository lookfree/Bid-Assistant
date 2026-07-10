import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import { Hono } from "hono"
import { projectRoutes, type ProjectDeps } from "../src/routes/projects"
import * as billing from "../src/services/billing-stub"
import { grant, getBalance } from "../src/services/credits"
import { seedConfigs, setConfig } from "../src/services/config"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, bidProjects, projectSteps } from "../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连真库（钱路径走真账本，只 mock agent client）

// POST /api/projects/:id/chapters/:chapterId/rewrite 单章改写计费全路径（spec315a 契约 2）：
// hold(rewrite=25) → agent → 持久化 → settle 足额；失败 settleFailed 净 0；余额不足 402；content 未 done 409。

let agentFail = false
let settleFail = false // 置 true 模拟 settle 瞬断（持久化已成功）
let duringRewrite: (() => Promise<void>) | null = null // agent 调用期间执行（模拟并发 PATCH 编辑）
const captured: {
  ref: string
  holdId: string
  preDeductCalls: number
  rewriteArgs?: Parameters<ProjectDeps["rewriteChapter"]>[0]
} = { ref: "", holdId: "", preDeductCalls: 0 }

const NEW_HTML = "<p>改写后的正文（更正式）</p>"

// 钱走真账本（billing-stub → credits 真实现）；仅包一层捕获 ref/holdId 供幂等断言
const mockDeps: Partial<ProjectDeps> = {
  preDeduct: async (userId, op, ref) => {
    captured.preDeductCalls++
    const r = await billing.preDeduct(userId, op, ref)
    if (r.ok) {
      captured.ref = ref
      captured.holdId = r.holdId!
    }
    return r
  },
  settle: async (ref, holdId, actualCost) => {
    if (settleFail) throw new Error("settle 瞬断")
    return billing.settle(ref, holdId, actualCost)
  },
  rewriteChapter: async (opts) => {
    captured.rewriteArgs = opts
    if (agentFail) throw new Error("agent boom")
    if (duringRewrite) await duringRewrite() // 改写耗时窗口里的并发编辑
    return { chapter_id: opts.chapterId, html: NEW_HTML }
  },
}

const app = new Hono()
app.route("/api/projects", projectRoutes(mockDeps))

let tokenA = ""
let userA = ""
let tokenB = ""
let userB = ""
let projectId = "" // A 的项目，content done
let threadId = ""
let draftProjectId = "" // A 的项目，content 未 done
let poorProjectId = "" // B 的项目，content done 但 B 没积分

beforeAll(async () => {
  await seedConfigs()
  await setConfig("credit_cost.rewrite", 25) // 钉死口径，与环境解耦
  const a = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  tokenA = a.token
  userA = a.user.id
  await grant(userA, 100, { idempotencyKey: `g-rewrite-${userA}` })
  const b = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  tokenB = b.token
  userB = b.user.id // 不授信 → 余额 0

  threadId = `proj-${crypto.randomUUID()}`
  const [p] = await getDb()
    .insert(bidProjects)
    .values({ userId: userA, threadId, status: "running", currentStep: "review" })
    .returning()
  projectId = p!.id
  // content 步 result 即 chapters 字典 { <章id>: html }（agent _RESULT_KEY['content']='chapters'）
  await getDb().insert(projectSteps).values({
    projectId,
    step: "content",
    status: "done",
    result: { "ch-1": "<p>旧正文一</p>", "ch-2": "<p>旧正文二</p>" },
  })

  const [d] = await getDb()
    .insert(bidProjects)
    .values({ userId: userA, threadId: `proj-${crypto.randomUUID()}` })
    .returning()
  draftProjectId = d!.id

  const [pp] = await getDb()
    .insert(bidProjects)
    .values({ userId: userB, threadId: `proj-${crypto.randomUUID()}`, status: "running", currentStep: "review" })
    .returning()
  poorProjectId = pp!.id
  await getDb().insert(projectSteps).values({
    projectId: poorProjectId,
    step: "content",
    status: "done",
    result: { "ch-1": "<p>b</p>" },
  })
})

afterAll(async () => {
  await getDb().delete(users).where(inArray(users.id, [userA, userB])) // 项目/步/账本随 user 级联删
  await closeDb()
})

const rewrite = (id: string, chapterId: string, body: unknown, token: string) =>
  app.request(`/api/projects/${id}/chapters/${chapterId}/rewrite`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })

const contentResult = async () => {
  const [row] = await getDb().select().from(projectSteps).where(eq(projectSteps.projectId, projectId))
  return row!.result as Record<string, string>
}

describe("POST /:id/chapters/:chapterId/rewrite 单章改写（真账本）", () => {
  it("① 成功：扣 25、单章覆写其余章保留、同 ref settle 幂等不双扣", async () => {
    const res = await rewrite(projectId, "ch-1", { instruction: "更正式一些" }, tokenA)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { chapterId: string; html: string; cost: number }
    expect(body).toEqual({ chapterId: "ch-1", html: NEW_HTML, cost: 25 })

    // 余额 100 → 75（hold 25 → settle 足额）
    expect(await getBalance(userA)).toBe(75)

    // agent 调用契约：同 thread、章 id、指令原样、底稿=DB 现值（编辑过=编辑后，不吃 state 旧稿）
    expect(captured.rewriteArgs).toMatchObject({
      agentType: "bidding_agent",
      threadId,
      chapterId: "ch-1",
      instruction: "更正式一些",
      baseHtml: "<p>旧正文一</p>",
    })
    expect("model" in captured.rewriteArgs!).toBe(true) // 运营后台模型选择随请求下发（未配则 undefined）
    expect(captured.rewriteArgs?.userId).toBe(userA) // spec316：user_id 随改写下发，供节点隔离检索

    // 持久化：ch-1 覆写为新 html，ch-2 原样保留（snake 原样存储）
    const result = await contentResult()
    expect(result["ch-1"]).toBe(NEW_HTML)
    expect(result["ch-2"]).toBe("<p>旧正文二</p>")

    // 幂等：同 ref 再 settle（幂等键 settle:<ref>）不双扣
    await billing.settle(captured.ref, captured.holdId, 25)
    expect(await getBalance(userA)).toBe(75)
  })

  it("② agent 抛错：settleFailed 净 0（余额不变）、result 不变、502 agent_failed", async () => {
    agentFail = true
    try {
      const before = await getBalance(userA)
      const res = await rewrite(projectId, "ch-2", { instruction: "扩写" }, tokenA)
      expect(res.status).toBe(502)
      expect(((await res.json()) as { error: string }).error).toBe("agent_failed")
      expect(await getBalance(userA)).toBe(before) // hold 全额退还，净 0
      expect((await contentResult())["ch-2"]).toBe("<p>旧正文二</p>") // 失败不落任何改写
    } finally {
      agentFail = false
    }
  })

  it("②b 改写期间并发编辑另一章：落库前事务内重读 merge，编辑不被旧快照回滚", async () => {
    duringRewrite = async () => {
      // agent 改写 ch-1 的窗口里，用户编辑了 ch-2（PATCH 落库同语义，这里直写 DB）
      const [row] = await getDb().select().from(projectSteps).where(eq(projectSteps.projectId, projectId))
      await getDb()
        .update(projectSteps)
        .set({ result: { ...(row!.result as Record<string, string>), "ch-2": "<p>并发编辑后的二</p>" } })
        .where(eq(projectSteps.id, row!.id))
    }
    try {
      const res = await rewrite(projectId, "ch-1", { instruction: "再正式一些" }, tokenA)
      expect(res.status).toBe(200)
    } finally {
      duringRewrite = null
    }
    const result = await contentResult()
    expect(result["ch-1"]).toBe(NEW_HTML) // 改写结果落库
    expect(result["ch-2"]).toBe("<p>并发编辑后的二</p>") // 并发编辑保留，没被请求开始的旧快照冲掉
  })

  it("②c settle 瞬断：产物已持久化 → 仍 200 报 cost，钱已扣（hold 不退），不走 settleFailed", async () => {
    settleFail = true
    try {
      const before = await getBalance(userA)
      const res = await rewrite(projectId, "ch-2", { instruction: "扩写" }, tokenA)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { chapterId: string; html: string; cost: number }
      expect(body).toEqual({ chapterId: "ch-2", html: NEW_HTML, cost: 25 })
      expect((await contentResult())["ch-2"]).toBe(NEW_HTML) // 产物已交付
      expect(await getBalance(userA)).toBe(before - 25) // hold 已扣未退——绝不因 settle 瞬断退掉已交付产物的钱
    } finally {
      settleFail = false
    }
    // 收尾：把挂着的 hold 正常结算掉（幂等键 settle:<ref>），不留悬挂状态干扰后续用例
    await billing.settle(captured.ref, captured.holdId, 25)
  })

  it("③ 余额不足：402 insufficient，无 hold 残留（余额仍 0）", async () => {
    const res = await rewrite(poorProjectId, "ch-1", { instruction: "润色" }, tokenB)
    expect(res.status).toBe(402)
    expect(((await res.json()) as { error: string }).error).toBe("insufficient")
    expect(await getBalance(userB)).toBe(0) // preDeduct 余额不足即拒，无扣减/挂起 hold
  })

  it("④ content 未 done：409 content_not_done 且不扣钱（不触 preDeduct）", async () => {
    const calls = captured.preDeductCalls
    const before = await getBalance(userA)
    const res = await rewrite(draftProjectId, "ch-1", { instruction: "润色" }, tokenA)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe("content_not_done")
    expect(captured.preDeductCalls).toBe(calls) // 预扣根本没被调
    expect(await getBalance(userA)).toBe(before)
  })

  it("空 instruction → 400 不扣钱；他人项目 → 404；非 uuid → 404", async () => {
    const calls = captured.preDeductCalls
    const bad = await rewrite(projectId, "ch-1", { instruction: "" }, tokenA)
    expect(bad.status).toBe(400)
    const theirs = await rewrite(projectId, "ch-1", { instruction: "x" }, tokenB)
    expect(theirs.status).toBe(404)
    const nonUuid = await rewrite("not-a-uuid", "ch-1", { instruction: "x" }, tokenA)
    expect(nonUuid.status).toBe(404)
    expect(captured.preDeductCalls).toBe(calls)
  })
})
