import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import { projectRoutes, buildStateOverrides, type ProjectDeps } from "../src/routes/projects"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, bidProjects, projectSteps, projectFiles, libraryItems, plans, subscriptions } from "../src/db/schema"
import { ContentTiersConfigError, holdAmountFor, type ContentTier } from "../src/services/content-pricing"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"
import { resetFreeEntitlementsCache } from "../src/services/entitlements"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连真库

let token = ""
let userId = ""
let capturedRunId = ""
const captured: {
  preDeductSteps: string[]
  preDeductAmounts: Array<number | undefined> // 第 4 参（content 走阶梯金额，其余步 undefined）
  preDeductUserId?: string
  createRunOpts?: Parameters<ProjectDeps["createRun"]>[0]
  settleArgs?: { ref: string; holdId: string; actualCost: number }
  releasedRefs: string[]
} = { preDeductSteps: [], preDeductAmounts: [], releasedRefs: [] }

// 各步 agent result（snake 原样）：read 带 doc_sections（spec315a 契约 4）；content 即 chapters 字典；present 即 deck。
// content 的章 id 故意带下划线（LLM 自由字符串）：验证全链路不做大小写转换（ch_1 不许变形成 ch1）。
const STEP_RESULTS: Record<string, unknown> = {
  read: {
    categories: [{ key: "qualification", title: "资格", items: [{ clause_ids: ["sec-1-c1"], is_new: false }] }],
    doc_sections: [{ id: "sec-1-c1", text: "投标人须具备 ISO27001 认证" }],
  },
  outline: { chapters: [{ id: "ch-1", chapter_title: "技术方案", clause_ids: ["sec-1-c1"] }] },
  content: { ch_1: "<p>正文一</p>" },
  review: { findings: [] },
  present: { template: "gov", slides: [{ id: "s-1", title: "封面" }] },
  export: { docx: "artifacts/x.docx", pptx: "artifacts/x.pptx" },
}
let runStep = "" // createRun 时记下本 run 的步，getRun 按步返回对应 result
let overridesBoom = false // 置 true 让 buildStateOverrides 抛错（模拟 DB 抖动）
let noModel = false // 置 true 让 getAgentModel 返回 undefined（模拟运营后台未配置模型）

// content 步预扣额（计费阶梯）也走注入，绝不读写共享的 billing_configs：本文件断言的是**路由编排**，
// 而 credit_cost.content_tiers 是全环境共享的运营计费口径——为了造一个「非法阶梯」去写真库，会让
// 该窗口内所有真实用户的标书生成 400，且要靠一整套快照/还原兜底才不留错价。注入即彻底消除这个暴露。
const TEST_TIERS: ContentTier[] = [
  { maxChars: 50_000, cost: 40 },
  { maxChars: null, cost: 260 },
]
// none=阶梯正常；config=配置态错误（缺失/非法，路由应转 400）；infra=基建故障（DB 抖动，路由应原样上抛 5xx）
let holdAmountFault: "none" | "config" | "infra" = "none"

const mockDeps: Partial<ProjectDeps> = {
  buildStateOverrides: async (projectId, step) => {
    if (overridesBoom) throw new Error("db jitter")
    return buildStateOverrides(projectId, step)
  },
  // 签名与真 preDeduct 对齐到 4 参：少传第 4 参（content 阶梯金额）时断言才拿得到 undefined，
  // 否则路由把金额丢了测试也发现不了。
  preDeduct: async (userId: string, op: string, _ref: string, amount?: number) => {
    captured.preDeductUserId = userId
    captured.preDeductSteps.push(op)
    captured.preDeductAmounts.push(amount)
    return { ok: true, holdId: `hold-${op}`, hold: 10 }
  },
  settle: async (ref: string, holdId: string, actualCost: number) => {
    captured.settleArgs = { ref, holdId, actualCost }
    return actualCost
  },
  settleContent: async (_ref: string, _holdId: string, heldAmount: number) => heldAmount, // content 步按篇幅结算，mock 全额
  settleFailed: async (ref: string) => {
    captured.releasedRefs.push(ref)
  },
  // 与真实 resolveStepHoldAmount 同语义：content 取阶梯最大价，其余步 undefined（走 credit_cost.<step>）。
  resolveStepHoldAmount: async (step: string) => {
    if (holdAmountFault === "infra") throw new Error("db jitter")
    if (holdAmountFault === "config") throw new ContentTiersConfigError("计费阶梯必须有且只有一个顶档（maxChars=null）")
    return step === "content" ? holdAmountFor(TEST_TIERS) : undefined
  },
  createRun: async (opts) => {
    captured.createRunOpts = opts
    runStep = (opts.input as { step: string }).step
    capturedRunId = crypto.randomUUID()
    return { run_id: capturedRunId }
  },
  relayStream: async function* () {
    yield "data: 进度\n\n"
  },
  getRun: async () => ({ status: "succeeded", result: STEP_RESULTS[runStep] }),
  // 模型必须来自运营后台配置：默认给一份有效选择；置 noModel 模拟未配置（步进应 400）。
  getAgentModel: async () =>
    noModel
      ? undefined
      : {
          provider: "deepseek",
          model: "deepseek-chat",
          fallbacks: "",
          params: { temperature: 0.7, max_tokens: 8192, top_p: 1 },
          chain: [{ provider: "deepseek", model: "deepseek-chat" }],
        },
}

const app = new Hono()
app.route("/api/projects", projectRoutes(mockDeps))

beforeAll(async () => {
  const r = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => "ok" as const)
  token = r.token
  userId = r.user.id
  // POST /api/projects 建项目校验 fileKey 属主（spec320）：先落一行本人已上传的 project_files
  await getDb().insert(projectFiles).values({
    userId,
    bucket: "bidsaas",
    key: "uploads/x/tender.pdf",
    filename: "tender.pdf",
    contentType: "application/pdf",
    size: 1,
    status: "uploaded",
  })
})

afterAll(async () => {
  holdAmountFault = "none" // 用例体超时时它的 finally 不会执行，开关必须在此兜底复位
  await getDb().delete(users).where(eq(users.id, userId)) // 项目/步随 user 级联删
  await closeDb()
})

const auth = () => ({ Authorization: `Bearer ${token}`, "content-type": "application/json" })

describe("/api/projects 按步编排", () => {
  let projectId = ""

  it("建项目返回 threadId", async () => {
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ fileKey: "uploads/x/tender.pdf" }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string; threadId: string }
    expect(body.threadId.startsWith("proj-")).toBe(true)
    projectId = body.id
  })

  it("draft 项目跳步（outline）→ 409 且不预扣不建 run", async () => {
    const before = captured.preDeductSteps.length
    const res = await app.request(`/api/projects/${projectId}/steps/outline`, { method: "POST", headers: auth() })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe("out_of_order")
    expect(captured.preDeductSteps.length).toBe(before) // 未调 preDeduct
  })

  it("read 步：预扣→建 run(带 threadId)→SSE 中继→存结果(snake_case)→currentStep→outline；SSE result 已 camelCase", async () => {
    const res = await app.request(`/api/projects/${projectId}/steps/read`, { method: "POST", headers: auth() })
    expect(res.status).toBe(200)
    const sse = await res.text()

    expect(captured.preDeductSteps).toContain("read")
    expect(captured.createRunOpts?.agentType).toBe("bidding_agent")
    expect((captured.createRunOpts?.input as { step: string }).step).toBe("read")
    expect((captured.createRunOpts?.input as { text: string }).text).toContain("key=uploads/x/tender.pdf")
    // spec320：单文件项目 files 是一元素数组（恒等，名取 project_files.filename）
    expect((captured.createRunOpts?.input as { files: Array<{ key: string; name: string }> }).files).toEqual([
      { key: "uploads/x/tender.pdf", name: "tender.pdf" },
    ])
    expect(captured.createRunOpts?.userId).toBe(userId) // spec316：user_id 随 run 下发
    expect(sse).toContain("data: 进度")
    expect(sse).toContain("event: step.done")
    expect(sse).toContain("clauseIds") // SSE 的 result 已转 camelCase
    expect(captured.preDeductUserId).toBe(userId) // 预扣落到发起用户头上
    expect(captured.settleArgs?.holdId).toBe("hold-read")
    expect(captured.settleArgs?.actualCost).toBe(10) // v1 按口径全额结算

    // 落库为 snake_case 原样；currentStep 推进
    const [s] = await getDb().select().from(projectSteps).where(eq(projectSteps.runId, capturedRunId))
    if (!s) throw new Error("project_step 未落库")
    expect(s.status).toBe("done")
    expect(JSON.stringify(s.result)).toContain("clause_ids")
    const [p] = await getDb().select().from(bidProjects).where(eq(bidProjects.id, projectId))
    expect(p?.currentStep).toBe("outline")
    expect(p?.status).toBe("running")
  })

  it("GET /:id 返回项目 + 各步 result（camelCase）", async () => {
    const res = await app.request(`/api/projects/${projectId}`, { headers: auth() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { steps: Array<{ result: unknown }> }
    expect(JSON.stringify(body.steps[0]?.result)).toContain("clauseIds")
  })

  it("GET /:id 同一步多行历史（失败重试残留）→ 只回最新一行（防前端取到旧 failed 行渲染成空）", async () => {
    // 手工给 read 步插一条更早的 failed 历史行（自愈槽位只约束 running 唯一，failed 可并存）
    await getDb().insert(projectSteps).values({
      projectId,
      step: "read",
      status: "failed",
      createdAt: new Date(Date.now() - 3600_000),
    } as any)
    const res = await app.request(`/api/projects/${projectId}`, { headers: auth() })
    const body = (await res.json()) as { steps: Array<{ step: string; status: string }> }
    const reads = body.steps.filter((s) => s.step === "read")
    expect(reads.length).toBe(1)
    expect(reads[0]!.status).toBe("done")
  })

  it("currentStep=done 时允许重跑 export（渲染升级后重新出文件）；其它步仍 409", async () => {
    // 独立项目验门（不碰共享项目的流水线状态）
    const [p3] = await getDb()
      .insert(bidProjects)
      .values({ userId, threadId: `proj-${crypto.randomUUID()}`, currentStep: "done", status: "active" })
      .returning()
    const readAgain = await app.request(`/api/projects/${p3!.id}/steps/read`, { method: "POST", headers: auth() })
    expect(readAgain.status).toBe(409) // 其它步仍被顺序门拦住
    const rerun = await app.request(`/api/projects/${p3!.id}/steps/export`, { method: "POST", headers: auth() })
    expect(rerun.status).not.toBe(409) // export 过了顺序门（后续 2xx/402 由计费与 mock 决定）
  })

  it("述标独立：currentStep=present 允许直接 export（跳过述标）→ 完成后推进 done；done 后可补跑 present 且不回退", async () => {
    const [p4] = await getDb()
      .insert(bidProjects)
      .values({ userId, threadId: `proj-${crypto.randomUUID()}`, currentStep: "present", status: "running" })
      .returning()
    const res = await app.request(`/api/projects/${p4!.id}/steps/export`, { method: "POST", headers: auth() })
    expect(res.status).toBe(200)
    await res.text() // 排干 SSE 流，确保收尾（finalize）完成后再断言推进
    const [after] = await getDb().select().from(bidProjects).where(eq(bidProjects.id, p4!.id))
    expect(after?.currentStep).toBe("done") // 跳过述标直出：export 完成即整本 done，不留永久 running
    expect(after?.status).toBe("done")
    // done 后补跑 present：过顺序门；完成后仍是 done（advanceGuard 不匹配，不回退到 export）
    const res2 = await app.request(`/api/projects/${p4!.id}/steps/present`, { method: "POST", headers: auth() })
    expect(res2.status).toBe(200)
    await res2.text() // 同上：排干流再断言
    const [after2] = await getDb().select().from(bidProjects).where(eq(bidProjects.id, p4!.id))
    expect(after2?.currentStep).toBe("done")
    expect(after2?.status).toBe("done")
  })

  it("spec330 生成配置：content 收 targetChars 转 run_input.target_chars;坏值 400 不预扣", async () => {
    const [p5] = await getDb()
      .insert(bidProjects)
      .values({ userId, threadId: `proj-${crypto.randomUUID()}`, currentStep: "content", status: "running" })
      .returning()
    const before = captured.preDeductSteps.length
    const bad = await app.request(`/api/projects/${p5!.id}/steps/content`, {
      method: "POST", headers: auth(), body: JSON.stringify({ targetChars: 5000 }), // 低于 1 万下限
    })
    expect(bad.status).toBe(400)
    expect(captured.preDeductSteps.length).toBe(before) // 未预扣（快照在请求前,断言才有意义）
    const ok = await app.request(`/api/projects/${p5!.id}/steps/content`, {
      method: "POST", headers: auth(), body: JSON.stringify({ targetChars: 120000 }),
    })
    expect(ok.status).toBe(200)
    await ok.text()
    expect((captured.createRunOpts?.input as { run_input: { target_chars?: number } }).run_input.target_chars).toBe(120000)
  })

  it("spec330 生成配置：export 收 format 转 run_input.format;非法字体 400", async () => {
    const [p6] = await getDb()
      .insert(bidProjects)
      .values({ userId, threadId: `proj-${crypto.randomUUID()}`, currentStep: "export", status: "running" })
      .returning()
    const bad = await app.request(`/api/projects/${p6!.id}/steps/export`, {
      method: "POST", headers: auth(), body: JSON.stringify({ format: { body_font: "Comic Sans" } }),
    })
    expect(bad.status).toBe(400)
    const ok = await app.request(`/api/projects/${p6!.id}/steps/export`, {
      method: "POST", headers: auth(),
      body: JSON.stringify({ format: { body_font: "仿宋", margin_cm: { top: 2.2 }, line_spacing: 1.5 } }),
    })
    expect(ok.status).toBe(200)
    await ok.text()
    const ri = (captured.createRunOpts?.input as { run_input: { format?: Record<string, unknown> } }).run_input
    expect(ri.format).toEqual({ body_font: "仿宋", margin_cm: { top: 2.2 }, line_spacing: 1.5 })
  })

  it("重新导出不计费（用户口径 2026-07-28）：导出过的项目再导出 → 零预扣但照常重渲", async () => {
    // 导出是确定性渲染步（无 LLM）。此前前端「已有产物就直接下载」导致编辑/改写/提纲调整
    // 全都拿不到（下载到旧文件），改为每次点导出都重渲——那么对同一份内容反复收费说不通。
    const [pr] = await getDb()
      .insert(bidProjects)
      .values({ userId, threadId: `proj-${crypto.randomUUID()}`, currentStep: "done", status: "done" })
      .returning()
    const first = await app.request(`/api/projects/${pr!.id}/steps/export`, { method: "POST", headers: auth() })
    expect(first.status).toBe(200)
    await first.text()
    expect(captured.preDeductSteps.at(-1)).toBe("export") // 首次导出正常收费

    const before = captured.preDeductSteps.length
    const again = await app.request(`/api/projects/${pr!.id}/steps/export`, { method: "POST", headers: auth() })
    expect(again.status).toBe(200)
    await again.text()
    expect(captured.preDeductSteps.length).toBe(before) // 二次导出零预扣
    const rows = await getDb()
      .select({ id: projectSteps.id, cost: projectSteps.costPoints })
      .from(projectSteps)
      .where(and(eq(projectSteps.projectId, pr!.id), eq(projectSteps.step, "export")))
    expect(rows.length).toBe(2)              // 确实重渲了一遍,不是复用旧产物
    expect(rows.at(-1)!.cost).toBe(0)        // 重渲行落 0 费
    await getDb().delete(bidProjects).where(eq(bidProjects.id, pr!.id))
  })

  it("项目级并发闸（审查修正）：present 在途时 export 一律 409 step_already_running", async () => {
    const [p7] = await getDb()
      .insert(bidProjects)
      .values({ userId, threadId: `proj-${crypto.randomUUID()}`, currentStep: "present", status: "running" })
      .returning()
    await getDb().insert(projectSteps).values({ projectId: p7!.id, step: "present", status: "running" })
    const res = await app.request(`/api/projects/${p7!.id}/steps/export`, { method: "POST", headers: auth() })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe("step_already_running")
    await getDb().delete(bidProjects).where(eq(bidProjects.id, p7!.id))
  })

  it("再推 read（已不是当前步）→ 409", async () => {
    const res = await app.request(`/api/projects/${projectId}/steps/read`, { method: "POST", headers: auth() })
    expect(res.status).toBe(409)
  })

  it("同一步已有 running 占位 → 409（并发双击 DB 层挡掉）", async () => {
    const [p2] = await getDb()
      .insert(bidProjects)
      .values({ userId, threadId: `proj-${crypto.randomUUID()}` })
      .returning()
    await getDb().insert(projectSteps).values({ projectId: p2!.id, step: "read", status: "running" })
    const res = await app.request(`/api/projects/${p2!.id}/steps/read`, { method: "POST", headers: auth() })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe("step_already_running")
  })

  it("非 uuid 的 :id → 404（不落 PG 22P02 → 500）", async () => {
    const step = await app.request("/api/projects/not-a-uuid/steps/read", { method: "POST", headers: auth() })
    expect(step.status).toBe(404)
    const detail = await app.request("/api/projects/not-a-uuid", { headers: auth() })
    expect(detail.status).toBe(404)
    const artifact = await app.request("/api/projects/not-a-uuid/artifacts/docx", { headers: auth() })
    expect(artifact.status).toBe(404)
  })

  it("未知步骤 → 400；他人项目 → 404", async () => {
    const bad = await app.request(`/api/projects/${projectId}/steps/nope`, { method: "POST", headers: auth() })
    expect(bad.status).toBe(400)
    const other = await app.request(`/api/projects/${crypto.randomUUID()}/steps/read`, {
      method: "POST",
      headers: auth(),
    })
    expect(other.status).toBe(404)
  })

  // —— spec315a：input 五键（run_input / state_overrides）+ doc_sections 链路 ——

  /** 推进一步并耗尽 SSE，返回本次 createRun 的 input 与 SSE 全文。 */
  const runStepAndGetInput = async (step: string, body?: unknown) => {
    const res = await app.request(`/api/projects/${projectId}/steps/${step}`, {
      method: "POST",
      headers: auth(),
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    expect(res.status).toBe(200)
    const sse = await res.text()
    expect(sse).toContain("event: step.done")
    return { input: captured.createRunOpts?.input as Record<string, unknown>, sse }
  }

  it("read 步 result 含 doc_sections → GET /:id 自动转 camel（docSections，链路零改动）", async () => {
    const res = await app.request(`/api/projects/${projectId}`, { headers: auth() })
    const body = (await res.json()) as { steps: Array<{ step: string; result: unknown }> }
    const read = body.steps.find((s) => s.step === "read")
    expect(JSON.stringify(read!.result)).toContain('"docSections"')
    expect(JSON.stringify(read!.result)).toContain("投标人须具备 ISO27001 认证")
  })

  it("outline 步：非 present 步 run_input 只带 rag（spec316 种子默认），read/outline 无 state_overrides", async () => {
    const { input } = await runStepAndGetInput("outline")
    expect(input.run_input).toEqual({ rag: { enabled: true, top_k: 3 } })
    expect(input.state_overrides).toEqual({})
  })

  it("state_overrides 组装抛错（DB 抖动）→ 500，且不预扣、不留 running 占位行（组装先于占位/预扣）", async () => {
    overridesBoom = true
    try {
      const holds = captured.preDeductSteps.length
      const res = await app.request(`/api/projects/${projectId}/steps/content`, { method: "POST", headers: auth() })
      expect(res.status).toBe(500)
      expect(captured.preDeductSteps.length).toBe(holds) // 没预扣 → 没有可泄漏的 hold
      const rows = await getDb()
        .select()
        .from(projectSteps)
        .where(and(eq(projectSteps.projectId, projectId), eq(projectSteps.step, "content")))
      expect(rows.length).toBe(0) // 占位行没插 → 部分唯一索引不会让重试恒 409
    } finally {
      overridesBoom = false
    }
  })

  it("content 步：state_overrides.outline 回灌已存提纲；SSE step.done 的章 id 键不做大小写转换", async () => {
    const { input, sse } = await runStepAndGetInput("content") // 上一测未留残行，这里正常推进
    expect(input.state_overrides).toEqual({ outline: STEP_RESULTS.outline })
    // content_generation=已完成正文步数(首次为 0):正文步断点缓存的代数基准(2026-08-08 新引擎)
    expect(input.run_input).toEqual({ rag: { enabled: true, top_k: 3 }, content_generation: 0 })
    expect(sse).toContain('"ch_1"') // 章 id 是 LLM 自由字符串，toCamel 会把 ch_1 转坏成 ch1
    expect(sse).not.toContain('"ch1"')
  })

  it("review 步：state_overrides 带 outline+chapters（体检读编辑后现值，不与编辑分叉）", async () => {
    const { input } = await runStepAndGetInput("review")
    expect(input.state_overrides).toEqual({
      outline: STEP_RESULTS.outline,
      chapters: STEP_RESULTS.content,
    })
  })

  it("present 步：非法 duration → 400 不留占位行；{duration,template} 透传；state_overrides 带 outline+chapters", async () => {
    const bad = await app.request(`/api/projects/${projectId}/steps/present`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ duration: 12 }),
    })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: string }).error).toBe("invalid_input")

    // 合法参数正常推进（400 未留 running 残行，否则这里会 409）
    const { input } = await runStepAndGetInput("present", { duration: 20, template: "gov" })
    // rag 并入 run_input，present 既有的 duration/template 不丢（spec316 契约要点）
    expect(input.run_input).toEqual({ duration: 20, template: "gov", rag: { enabled: true, top_k: 3 } })
    expect(input.state_overrides).toEqual({
      outline: STEP_RESULTS.outline,
      chapters: STEP_RESULTS.content,
    })
  })

  it("export 步：state_overrides 带 outline/chapters/deck 三键（各取对应步 result 现值）", async () => {
    const { input } = await runStepAndGetInput("export")
    expect(input.state_overrides).toEqual({
      outline: STEP_RESULTS.outline,
      chapters: STEP_RESULTS.content, // content 步 result 即 chapters 字典
      deck: STEP_RESULTS.present, // present 步 result 即 deck
    })
    // 最后一步完成 → 整本 done
    const [p] = await getDb().select().from(bidProjects).where(eq(bidProjects.id, projectId))
    expect(p?.currentStep).toBe("done")
    expect(p?.status).toBe("done")
  })
})

describe("present 步：企业 PPT 母版解析（enterpriseTemplateItemId → run_input.enterprise_template_key）", () => {
  // 企业 PPT 母版是**专业版权益**（free 档 features.pptTemplate=false → 403）。会用这个功能的用户
  // 必然持有相应订阅，测试就给他这个真实身份；订阅只在本组内有效，用完即撤——留着会让同文件
  // 其它用例意外拿到会员权益，把权益门的回归悄悄遮掉。
  beforeAll(async () => {
    const [pro] = await getDb().select({ id: plans.id }).from(plans).where(eq(plans.code, "professional")).limit(1)
    if (pro) {
      await getDb()
        .insert(subscriptions)
        .values({ userId, planId: pro.id, status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) })
        .onConflictDoNothing()
    }
  })
  afterAll(async () => {
    await getDb().delete(subscriptions).where(eq(subscriptions.userId, userId))
  })

  /** 新建项目并快速推进到 present 步（read/outline/content/review 用默认 body，走同一套 mockDeps）。 */
  async function projectAtPresent(): Promise<string> {
    const create = await app.request("/api/projects", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ fileKey: "uploads/x/tender.pdf" }),
    })
    const pid = ((await create.json()) as { id: string }).id
    for (const step of ["read", "outline", "content", "review"]) {
      const res = await app.request(`/api/projects/${pid}/steps/${step}`, { method: "POST", headers: auth() })
      expect(res.status).toBe(200)
      await res.text() // 耗尽 SSE
    }
    return pid
  }

  it("presentation 分类条目 + 本人 pptx 附件 → run_input.enterprise_template_key 命中该 key", async () => {
    const [pptxFile] = await getDb()
      .insert(projectFiles)
      .values({
        userId,
        bucket: "bidsaas",
        key: `uploads/${userId}/enterprise-master.pptx`,
        filename: "企业模板.pptx",
        contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        size: 1,
        status: "uploaded",
      })
      .returning()
    const [item] = await getDb()
      .insert(libraryItems)
      .values({
        userId,
        category: "presentation",
        title: "企业模板",
        attachments: [{ fileId: pptxFile!.id, name: "企业模板.pptx" }],
      })
      .returning()

    const pid = await projectAtPresent()
    const res = await app.request(`/api/projects/${pid}/steps/present`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ duration: 15, enterpriseTemplateItemId: item!.id }),
    })
    expect(res.status).toBe(200)
    await res.text()
    expect((captured.createRunOpts?.input as { run_input: Record<string, unknown> }).run_input).toEqual({
      duration: 15,
      enterprise_template_key: pptxFile!.key,
      rag: { enabled: true, top_k: 3 },
    })
  })

  it("他人的资料库条目（越权引用）→ 静默忽略，不带 enterprise_template_key，不 400 挡掉整个 present 步", async () => {
    const other = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => "ok" as const)
    const [otherFile] = await getDb()
      .insert(projectFiles)
      .values({
        userId: other.user.id,
        bucket: "bidsaas",
        key: `uploads/${other.user.id}/other-master.pptx`,
        filename: "别人的模板.pptx",
        contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        size: 1,
        status: "uploaded",
      })
      .returning()
    const [otherItem] = await getDb()
      .insert(libraryItems)
      .values({
        userId: other.user.id,
        category: "presentation",
        title: "别人的模板",
        attachments: [{ fileId: otherFile!.id, name: "别人的模板.pptx" }],
      })
      .returning()

    const pid = await projectAtPresent()
    const res = await app.request(`/api/projects/${pid}/steps/present`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ duration: 15, enterpriseTemplateItemId: otherItem!.id }),
    })
    expect(res.status).toBe(200)
    await res.text()
    expect((captured.createRunOpts?.input as { run_input: Record<string, unknown> }).run_input).toEqual({
      duration: 15,
      rag: { enabled: true, top_k: 3 },
    })
    await getDb().delete(users).where(eq(users.id, other.user.id))
  })
})

// 步骤进度事件流（只读中继）：无 running run → idle；有 running run → 中继 agent stream（mock 回放）。
describe("GET /:id/steps/:step/events 进度事件流", () => {
  let pid = ""

  beforeAll(async () => {
    const [p] = await getDb()
      .insert(bidProjects)
      .values({ userId, threadId: `proj-${crypto.randomUUID()}`, tenderFileKey: "uploads/x/tender.pdf", name: "ev" })
      .returning()
    pid = p!.id
  })

  it("非 uuid → 404", async () => {
    const res = await app.request(`/api/projects/not-a-uuid/steps/content/events`, { headers: auth() })
    expect(res.status).toBe(404)
  })

  it("无 running 步 → 立即 event: idle（不中继）", async () => {
    const res = await app.request(`/api/projects/${pid}/steps/content/events`, { headers: auth() })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("event: idle")
  })

  it("有 running 步 → 中继 agent 进度流", async () => {
    await getDb()
      .insert(projectSteps)
      .values({ projectId: pid, step: "content", status: "running", runId: crypto.randomUUID() })
    const res = await app.request(`/api/projects/${pid}/steps/content/events`, { headers: auth() })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("data: 进度") // mock relayStream 回放帧
  })

  it("非本人项目 → 404（越权不可订阅）", async () => {
    const other = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => "ok" as const)
    const res = await app.request(`/api/projects/${pid}/steps/content/events`, {
      headers: { Authorization: `Bearer ${other.token}`, "content-type": "application/json" },
    })
    expect(res.status).toBe(404)
    await getDb().delete(users).where(eq(users.id, other.user.id))
  })

  it("GET /:id?slim=1 → 步骤只带状态不带 result（首屏免 1MB 传输税）；单步结果走 result 端点", async () => {
    const [proj] = await getDb()
      .insert(bidProjects)
      .values({ userId, threadId: `proj-${crypto.randomUUID()}`, tenderFileKey: "uploads/x/tender.pdf", name: "slim" })
      .returning()
    await getDb().insert(projectSteps).values({
      projectId: proj!.id, step: "read", status: "done",
      result: { categories: [{ key: "overview", title: "概况", items: [] }], doc_sections: [{ id: "sec-1-c1", text: "条款" }] },
    })
    // slim：result 一律 null
    const slim = await app.request(`/api/projects/${proj!.id}?slim=1`, { headers: auth() })
    expect(slim.status).toBe(200)
    const sbody = (await slim.json()) as { steps: Array<{ step: string; status: string; result: unknown }> }
    expect(sbody.steps[0]!.status).toBe("done")
    expect(sbody.steps[0]!.result).toBeNull()
    // 全量（缺省）不受影响：result 照常返回（camelCase）
    const full = await app.request(`/api/projects/${proj!.id}`, { headers: auth() })
    const fbody = (await full.json()) as { steps: Array<{ result: { docSections?: unknown[] } }> }
    expect(fbody.steps[0]!.result.docSections?.length).toBe(1)
    // 单步结果端点：camelCase；无 done 行的步 404
    const res = await app.request(`/api/projects/${proj!.id}/steps/read/result`, { headers: auth() })
    expect(res.status).toBe(200)
    expect((((await res.json()) as { result: { docSections?: unknown[] } }).result.docSections ?? []).length).toBe(1)
    const missing = await app.request(`/api/projects/${proj!.id}/steps/outline/result`, { headers: auth() })
    expect(missing.status).toBe(404)
  })

  it("运营后台未配置模型 → 步进 400 model_not_configured，不预扣不建 run、不占步位", async () => {
    const [proj] = await getDb()
      .insert(bidProjects)
      .values({ userId, threadId: `proj-${crypto.randomUUID()}`, tenderFileKey: "uploads/x/tender.pdf", name: "nomodel" })
      .returning()
    const before = captured.preDeductSteps.length
    noModel = true
    const res = await app.request(`/api/projects/${proj!.id}/steps/read`, { method: "POST", headers: auth() })
    noModel = false
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("model_not_configured")
    expect(captured.preDeductSteps.length).toBe(before) // 未预扣
    const slots = await getDb().select().from(projectSteps).where(eq(projectSteps.projectId, proj!.id))
    expect(slots.length).toBe(0) // 未占步位
  })

  it("计费阶梯非法 → content 步 400 content_tiers_not_configured，不预扣不占步位；合法则按阶梯最大价预扣", async () => {
    const [proj] = await getDb()
      .insert(bidProjects)
      .values({ userId, threadId: `proj-${crypto.randomUUID()}`, currentStep: "content", status: "running", name: "notiers" })
      .returning()
    const before = captured.preDeductSteps.length
    try {
      holdAmountFault = "config" // 缺顶档一类的非法/缺失阶梯
      const bad = await app.request(`/api/projects/${proj!.id}/steps/content`, { method: "POST", headers: auth() })
      expect(bad.status).toBe(400)
      expect(((await bad.json()) as { error: string }).error).toBe("content_tiers_not_configured")
      expect(captured.preDeductSteps.length).toBe(before) // 未预扣
      const slots = await getDb().select().from(projectSteps).where(eq(projectSteps.projectId, proj!.id))
      expect(slots.length).toBe(0) // 未占步位（校验前置于 acquireStepSlot）

      // 合法阶梯：预扣额 = 各档最大价（260），且账本 op 为 content（不再是 content_long）
      holdAmountFault = "none"
      const ok = await app.request(`/api/projects/${proj!.id}/steps/content`, { method: "POST", headers: auth() })
      expect(ok.status).toBe(200)
      await ok.text()
      expect(captured.preDeductSteps.at(-1)).toBe("content")
      expect(captured.preDeductAmounts.at(-1)).toBe(260)
    } finally {
      holdAmountFault = "none"
    }
  })

  it("阶梯读取遇基建故障 → 5xx（不是 400 误导排障），同样不占步位不预扣", async () => {
    const [proj] = await getDb()
      .insert(bidProjects)
      .values({ userId, threadId: `proj-${crypto.randomUUID()}`, currentStep: "content", status: "running", name: "tiersboom" })
      .returning()
    const before = captured.preDeductSteps.length
    // 阶梯读取抛「非 ContentTiersConfigError」= DB 抖动一类基建故障：路由必须原样上抛成 5xx，
    // 而不是报成「去配阶梯」的 400（后者会把排障引向根本没坏的配置）。
    holdAmountFault = "infra"
    try {
      const res = await app.request(`/api/projects/${proj!.id}/steps/content`, { method: "POST", headers: auth() })
      expect(res.status).toBeGreaterThanOrEqual(500)
      expect(captured.preDeductSteps.length).toBe(before) // 未预扣
      const slots = await getDb().select().from(projectSteps).where(eq(projectSteps.projectId, proj!.id))
      expect(slots.length).toBe(0) // 未占步位（上抛点仍在 acquireStepSlot 之前）
    } finally {
      holdAmountFault = "none"
    }
  })
})

// 档位权益门禁（2026-08-02 QA 整改）：export/riskReview 此前只是配置键、无执行点——后台把免费版
// 权限清了/置 false,免费用户照样导出 PDF、跑废标检查(QA 实测)。现接上执行点:显式 false 即 403,
// 先于占位/预扣(无 hold 残留、不占步位)。
describe("档位权益门禁：export / riskReview 假开关接线", () => {
  const setFreeFeature = async (key: string, val: boolean | null) => {
    const rows = await getDb().select({ id: plans.id, features: plans.features }).from(plans).where(eq(plans.code, "free"))
    for (const r of rows) {
      const f = { ...((r.features as Record<string, unknown>) ?? {}) }
      if (val === null) delete f[key]
      else f[key] = val
      await getDb().update(plans).set({ features: f }).where(eq(plans.id, r.id))
    }
    resetFreeEntitlementsCache()
  }

  const mkProject = async (currentStep: string) => {
    const [p] = await getDb().insert(bidProjects)
      .values({ userId, threadId: `proj-${crypto.randomUUID()}`, tenderFileKey: "uploads/x/tender.pdf",
                name: "gate", currentStep, status: "running" })
      .returning()
    return p!.id
  }

  it("features.export=false → 导出 403 feature_locked，不占步位不预扣；恢复后照常", async () => {
    const pid = await mkProject("export")
    const before = captured.preDeductSteps.length
    try {
      await setFreeFeature("export", false)
      const res = await app.request(`/api/projects/${pid}/steps/export`, { method: "POST", headers: auth() })
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: "feature_locked", feature: "export" })
      expect(captured.preDeductSteps.length).toBe(before)  // 未预扣
      const rows = await getDb().select().from(projectSteps)
        .where(and(eq(projectSteps.projectId, pid), eq(projectSteps.step, "export")))
      expect(rows.length).toBe(0)                          // 未占步位
    } finally {
      await setFreeFeature("export", true)
    }
    const ok = await app.request(`/api/projects/${pid}/steps/export`, { method: "POST", headers: auth() })
    expect(ok.status).toBe(200)                            // 恢复 true 即放行
  })

  it("features.riskReview=false → 废标检查 403；缺键（清除权限）按语义放行", async () => {
    const pid = await mkProject("review")
    try {
      await setFreeFeature("riskReview", false)
      const res = await app.request(`/api/projects/${pid}/steps/review`, { method: "POST", headers: auth() })
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: "feature_locked", feature: "riskReview" })
      // 缺键 = 未配置,一律放行(featureLocked 既有语义:清除权限≠禁用,置 false 才禁)
      await setFreeFeature("riskReview", null)
      const res2 = await app.request(`/api/projects/${pid}/steps/review`, { method: "POST", headers: auth() })
      expect(res2.status).toBe(200)
    } finally {
      await setFreeFeature("riskReview", true)
    }
  })
})
