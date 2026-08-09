import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import { Hono } from "hono"
import { projectRoutes, type ProjectDeps } from "../src/routes/projects"
import * as billing from "../src/services/billing-stub"
import { grant, getBalance } from "../src/services/credits"
import { seedConfigs, setConfig, getConfig } from "../src/services/config"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, bidProjects, projectSteps, creditTransactions } from "../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连真库（钱路径走真账本，只 mock agent client）

// POST /api/projects/:id/chapters/:chapterId/rewrite 单章改写计费全路径（spec315a 契约 2）：
// hold(rewrite=25) → agent → 持久化 → settle 足额；失败 settleFailed 净 0；余额不足 402；content 未 done 409。

let agentFail = false
let agentTruncated = false // 置 true 模拟 agent 因输出被长度上限截断而拒收
let agentReturnsProse = false // 置 true 模拟模型纯文字回答（无任何 HTML 标签）
let settleFail = false // 置 true 模拟 settle 瞬断（持久化已成功）
let duringRewrite: (() => Promise<void>) | null = null // agent 调用期间执行（模拟并发 PATCH 编辑）
const captured: {
  ref: string
  holdId: string
  preDeductCalls: number
  rewriteCalls: number // agent 改写通道被真正调用的次数——系统章拒绝断言"没调"用它，不靠
  // 把 rewriteArgs 手动置回 undefined 再对着一次 await 之后的读取做类型窄化（TS 不会因为
  // 中间那次 await 调用而重新放宽属性类型，会把后续访问锁死成 never）。
  rewriteArgs?: Parameters<ProjectDeps["rewriteChapter"]>[0]
} = { ref: "", holdId: "", preDeductCalls: 0, rewriteCalls: 0 }

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
    captured.rewriteCalls++
    captured.rewriteArgs = opts
    if (agentFail) throw new Error("agent boom")
    // 与 agent-client 真实抛法同形：`agent rewriteChapter <status>: <agent 的 error 文本>`
    if (agentTruncated) throw new Error("agent rewriteChapter 502: rewrite_truncated: 模型没能完整改写本章（输出被长度上限截断）。")
    if (duringRewrite) await duringRewrite() // 改写耗时窗口里的并发编辑
    return { chapter_id: opts.chapterId, html: agentReturnsProse ? "这一章主要修改了响应时间与故障分级。" : NEW_HTML }
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
let sysChapterProjectId = "" // A 的项目，outline 含 sys-creds 系统章（终审 I1 第三道门）

let prevSignupGrant: unknown

beforeAll(async () => {
  await seedConfigs()
  await setConfig("credit_cost.rewrite", 25) // 钉死口径，与环境解耦
  // 本文件用绝对余额断言（100→75、B=0）：注册赠送必须钉 0，否则新用户带 200 分全盘打偏（同 checklist.export 惯例）
  prevSignupGrant = await getConfig("signup_grant_credits")
  await setConfig("signup_grant_credits", 0)
  const a = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => "ok" as const)
  tokenA = a.token
  userA = a.user.id
  await grant(userA, 100, { idempotencyKey: `g-rewrite-${userA}` })
  const b = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => "ok" as const)
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

  // outline 含 sys-creds 系统章 + 一个普通章，content 两章都有正文——用来验证系统章改写被
  // 就地拒绝、普通章不受影响（终审 I1 第三道门：改写路由要按库里提纲的 system 标记拒收）。
  const [sc] = await getDb()
    .insert(bidProjects)
    .values({ userId: userA, threadId: `proj-${crypto.randomUUID()}`, status: "running", currentStep: "review" })
    .returning()
  sysChapterProjectId = sc!.id
  await getDb().insert(projectSteps).values([
    {
      projectId: sysChapterProjectId,
      step: "outline",
      status: "done",
      result: {
        chapters: [
          { id: "sys-creds", no: "附录", title: "资格证明文件", group: "business", system: true, sourced: false, items: [] },
          { id: "ch-1", no: "第一章", title: "项目理解", group: "tech", sourced: true, items: [] },
        ],
      },
    },
    {
      projectId: sysChapterProjectId,
      step: "content",
      status: "done",
      result: { "sys-creds": "<h3>营业执照</h3>", "ch-1": "<p>旧正文</p>" },
    },
  ])
})

afterAll(async () => {
  await setConfig("signup_grant_credits", Number(prevSignupGrant ?? 200)) // 还原注册赠送（beforeAll 钉过 0）
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
  it("① 成功：不计费、单章覆写、其余章保留", async () => {
    const res = await rewrite(projectId, "ch-1", { instruction: "更正式一些" }, tokenA)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { chapterId: string; html: string; cost: number }
    expect(body).toEqual({ chapterId: "ch-1", html: NEW_HTML, cost: 0 })

    // 2026-07-29 口径：改写不碰账本——余额分文不动，账本零新增行（费用在下载侧）
    expect(await getBalance(userA)).toBe(100)
    expect(captured.preDeductCalls).toBe(0)

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
  })

  it("② agent 抛错：502 agent_failed、result 不变、余额自始不动", async () => {
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

  it("②c 输出被长度上限截断：422 rewrite_truncated、result 不变", async () => {
    // 这个映射靠跨三个模块拼出来的字符串（Python RuntimeError → chapters.py str(e) →
    // agent-client 模板）。任何一环改了错误形状，分支会**静默**退回笼统的 agent_failed，
    // 用户又只看到「改写失败，请稍后重试」——正是本次要消除的那个死循环。
    agentTruncated = true
    try {
      const res = await rewrite(projectId, "ch-2", { instruction: "扩写" }, tokenA)
      expect(res.status).toBe(422)
      expect(((await res.json()) as { error: string }).error).toBe("rewrite_truncated")
      expect((await contentResult())["ch-2"]).toBe("<p>旧正文二</p>") // 半截结果绝不落库
    } finally {
      agentTruncated = false
    }
  })

  it("②d 模型纯文字回答（无 HTML 标签）：拒收 502 rewrite_not_html、result 不变", async () => {
    agentReturnsProse = true
    try {
      const before = await getBalance(userA)
      const res = await rewrite(projectId, "ch-2", { instruction: "你改了哪里" }, tokenA)
      expect(res.status).toBe(502)
      expect(((await res.json()) as { error: string }).error).toBe("rewrite_not_html")
      expect(await getBalance(userA)).toBe(before) // 不碰账本
      expect((await contentResult())["ch-2"]).toBe("<p>旧正文二</p>") // 废品不落库
    } finally {
      agentReturnsProse = false
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

  it("③ 零余额用户照样能改写（2026-07-29 口径：改写不计费，不看余额）", async () => {
    // 旧口径此处是 402 insufficient；费用移到下载侧后，改写必须对欠费用户也开放——
    // 否则用户为已付费生成的正文做修改反而被余额挡住。
    expect(await getBalance(userB)).toBe(0)
    const res = await rewrite(poorProjectId, "ch-1", { instruction: "润色" }, tokenB)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { cost: number }).cost).toBe(0)
    expect(await getBalance(userB)).toBe(0) // 余额仍 0，未产生任何账本动作
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

  it("⑤ 附录系统章（sys-creds）：409 system_chapter，就地拒绝不调 agent；普通章不受影响", async () => {
    const rewriteCallsBefore = captured.rewriteCalls
    const preDeductCallsBefore = captured.preDeductCalls
    const res = await rewrite(sysChapterProjectId, "sys-creds", { instruction: "补充一份资质" }, tokenA)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe("system_chapter")
    expect(captured.rewriteCalls).toBe(rewriteCallsBefore) // agent 通道完全没被调
    expect(captured.preDeductCalls).toBe(preDeductCallsBefore)

    const ok = await rewrite(sysChapterProjectId, "ch-1", { instruction: "改得更正式" }, tokenA)
    expect(ok.status).toBe(200)
    expect(captured.rewriteCalls).toBe(rewriteCallsBefore + 1)
    expect(captured.rewriteArgs?.chapterId).toBe("ch-1")
  })
})
