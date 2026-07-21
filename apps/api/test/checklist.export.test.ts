import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { inArray } from "drizzle-orm"
import { Hono } from "hono"
import { checklistRoutes, type ChecklistDeps } from "../src/routes/checklist"
import * as billing from "../src/services/billing-stub"
import { grant, getBalance } from "../src/services/credits"
import { seedConfigs, setConfig } from "../src/services/config"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, bidProjects, projectSteps } from "../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连真库（钱路径走真账本，只 mock agent client / presign）

// POST /api/checklist/export 导出计费全路径（spec315b 契约 4）：
// hold(export=20) → agent 渲染 → 预签名 → settle 足额；agent 失败 settleFailed 净 0 → 502；余额不足 402。

let agentFail = false
let presignFail = false
let settleError: Error | null = null
let reportFail = false
let reportFormat: "docx" | "pdf" | null = null // null = 按请求 format 回显；"docx" 模拟 pdf 转换失败回落
const captured: {
  preDeductCalls: number
  payload?: Parameters<ChecklistDeps["renderChecklist"]>[0]
  reportPayload?: Record<string, unknown>
  readPayload?: Record<string, unknown>
} = { preDeductCalls: 0 }

const DOCX_KEY = "artifacts/checklist/test-fixed.docx"

// 钱走真账本（billing-stub → credits 真实现）；仅包一层计数/故障注入供钱护栏断言
const mockDeps: Partial<ChecklistDeps> = {
  preDeduct: async (userId, op, ref) => {
    captured.preDeductCalls++
    return billing.preDeduct(userId, op, ref)
  },
  renderChecklist: async (payload) => {
    captured.payload = payload
    if (agentFail) throw new Error("agent boom")
    return { key: DOCX_KEY }
  },
  renderReadReport: async (payload) => {
    captured.readPayload = payload
    if (reportFail) throw new Error("agent boom")
    return { key: "artifacts/report/read-fixed.docx" }
  },
  renderRiskReport: async (payload) => {
    captured.reportPayload = payload
    if (reportFail) throw new Error("agent boom")
    const fmt = reportFormat ?? ((payload.format as "docx" | "pdf") || "docx")
    return { key: `artifacts/report/test-fixed.${fmt}`, format: fmt }
  },
  presignGet: async (key, expiresIn) => {
    if (presignFail) throw new Error("presign boom")
    return `https://minio.test/${key}?exp=${expiresIn}`
  },
  settle: async (ref, holdId, actualCost) => {
    if (settleError) throw settleError
    return billing.settle(ref, holdId, actualCost)
  },
}

const app = new Hono()
app.route("/api/checklist", checklistRoutes(mockDeps))

let tokenA = ""
let userA = ""
let tokenB = ""
let userB = ""

// 前端合成后的 groups（agent 契约形状；键 camelCase，App 层负责 toSnake）
const GROUPS = [
  {
    id: "g1",
    title: "资质证照",
    items: [{ text: "营业执照在有效期内", status: "pass", owner: "张三", note: "", libraryHit: "已具备 · 营业执照" }],
  },
]

let prevSignupGrant: unknown

beforeAll(async () => {
  await seedConfigs()
  await setConfig("credit_cost.export", 20) // 钉死口径，与环境解耦
  // 注册赠送积分会打破本文件的余额假设（userA=100 变 300、userB≠0 → 402 永不触发）——
  // 注册前钉死为 0，afterAll 恢复原值（共享 dev 库，别把赠送配置永久关掉）。
  const { getConfig } = await import("../src/services/config")
  prevSignupGrant = await getConfig("signup_grant_credits")
  await setConfig("signup_grant_credits", 0)
  const a = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  tokenA = a.token
  userA = a.user.id
  await grant(userA, 100, { idempotencyKey: `g-cl-export-${userA}` })
  const b = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  tokenB = b.token
  userB = b.user.id // 不授信 → 余额 0
})

afterAll(async () => {
  // 恢复注册赠送配置（beforeAll 记录的原值；原本无该键则回落种子默认 200）
  await setConfig("signup_grant_credits", Number(prevSignupGrant ?? 200))
  await getDb().delete(users).where(inArray(users.id, [userA, userB])) // 账本随 user 级联删
  await closeDb()
})

const exportChecklist = (token: string, body: unknown) =>
  app.request("/api/checklist/export", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })

describe("POST /api/checklist/export 导出计费（真账本）", () => {
  it("① 成功：扣 20、返回预签名 url、payload 转 snake 透传 agent", async () => {
    const res = await exportChecklist(tokenA, { title: "终极审核表", groups: GROUPS })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { url: string; cost: number }
    expect(body.cost).toBe(20)
    expect(body.url).toBe(`https://minio.test/${DOCX_KEY}?exp=300`) // presign(key, 300)

    // 余额 100 → 80（hold 20 → settle 足额）
    expect(await getBalance(userA)).toBe(80)

    // agent 契约：title 透传、groups 键转 snake（libraryHit → library_hit），无项目则不带 projectName
    expect(captured.payload!.title).toBe("终极审核表")
    expect(captured.payload!.projectName).toBeUndefined()
    const item = (captured.payload!.groups[0] as { items: Record<string, unknown>[] }).items[0]!
    expect(item.library_hit).toBe("已具备 · 营业执照")
    expect("libraryHit" in item).toBe(false)
  })

  it("② agent 抛错：settleFailed 净 0（余额不变）、502 agent_failed", async () => {
    agentFail = true
    try {
      const before = await getBalance(userA)
      const res = await exportChecklist(tokenA, { groups: GROUPS })
      expect(res.status).toBe(502)
      expect(((await res.json()) as { error: string }).error).toBe("agent_failed")
      expect(await getBalance(userA)).toBe(before) // hold 全额退还，净 0
    } finally {
      agentFail = false
    }
  })

  it("③ 余额不足：402 insufficient，无 hold 残留（余额仍 0）", async () => {
    const res = await exportChecklist(tokenB, { groups: GROUPS })
    expect(res.status).toBe(402)
    expect(((await res.json()) as { error: string }).error).toBe("insufficient")
    expect(await getBalance(userB)).toBe(0) // preDeduct 余额不足即拒，无扣减/挂起 hold
  })

  it("④ 坏输入（groups 缺失/空数组）→ 400 且不触计费", async () => {
    const calls = captured.preDeductCalls
    expect((await exportChecklist(tokenA, {})).status).toBe(400)
    expect((await exportChecklist(tokenA, { groups: [] })).status).toBe(400)
    expect(captured.preDeductCalls).toBe(calls) // 预扣根本没被调
    expect(await getBalance(userA)).toBe(80)
  })

  it("⑤ settle 抛错：产物已交付仍 200，不退款（余额已扣 20，宁少收不多收）", async () => {
    settleError = new Error("settle boom")
    try {
      const before = await getBalance(userA)
      const res = await exportChecklist(tokenA, { groups: GROUPS })
      expect(res.status).toBe(200) // URL 照常交付
      const body = (await res.json()) as { url: string; cost: number }
      expect(body.url).toBe(`https://minio.test/${DOCX_KEY}?exp=300`)
      expect(body.cost).toBe(20) // settle 失败按预扣额记
      expect(await getBalance(userA)).toBe(before - 20) // hold 已扣不退（只记日志待对账）
    } finally {
      settleError = null
    }
  })

  it("⑥ presign 抛错：用户没拿到产物 URL → settleFailed 净 0（余额不变）", async () => {
    presignFail = true
    try {
      const before = await getBalance(userA)
      const res = await exportChecklist(tokenA, { groups: GROUPS })
      expect(res.status).toBe(500) // 路由 rethrow → 框架 500
      expect(await getBalance(userA)).toBe(before) // hold 全额退还，净 0
    } finally {
      presignFail = false
    }
  })

  it("⑦ 大小上限：组 >26 / 每组项 >100 / text >500 字 / title >200 字 → 400 不触计费", async () => {
    const calls = captured.preDeductCalls
    const before = await getBalance(userA)
    const item = { text: "检查项", status: "pass", owner: "", note: "", libraryHit: null }
    const group = (id: string, items: unknown[]) => ({ id, title: "资质证照", items })
    for (const body of [
      { groups: Array.from({ length: 27 }, (_, i) => group(`g${i}`, [item])) }, // 组数超限
      { groups: [group("g1", Array.from({ length: 101 }, () => item))] }, // 每组项数超限
      { groups: [group("g1", [{ ...item, text: "长".repeat(501) }])] }, // text 超长
      { groups: [group("g1", [{ ...item, note: "长".repeat(501) }])] }, // note 超长
      { groups: [{ id: "g1", title: "题".repeat(201), items: [item] }] }, // 组 title 超长
      { title: "题".repeat(201), groups: [group("g1", [item])] }, // 顶层 title 超长
    ]) {
      const res = await exportChecklist(tokenA, body)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe("invalid_input")
    }
    expect(captured.preDeductCalls).toBe(calls) // 预扣根本没被调
    expect(await getBalance(userA)).toBe(before)
  })
})

describe("POST /api/checklist/report 体检报告导出（免计费）", () => {
  const REPORT_BODY = {
    projectName: "招标文件.pdf·包件一",
    score: 82, high: 1, mid: 2, passed: 9,
    items: [{ level: "高", title: "缺少★ISO27001 认证", chapter: "资质文件", advice: "补充认证" }],
    passedItems: ["投标函格式符合要求"],
    format: "docx",
  }
  const exportReport = (token: string, body: unknown) =>
    app.request("/api/checklist/report", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    })

  it("成功：返回 {url, filename, format}；下载名带项目名（剥内嵌扩展名）；不触计费不动余额", async () => {
    const calls = captured.preDeductCalls
    const before = await getBalance(userA)
    const res = await exportReport(tokenA, REPORT_BODY)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { url: string; filename: string; format: string }
    expect(body.format).toBe("docx")
    expect(body.filename).toBe("招标文件·包件一-废标体检报告.docx") // .pdf 内嵌扩展名被剥
    expect(body.url).toContain("artifacts/report/")
    expect(captured.preDeductCalls).toBe(calls) // 免费：预扣完全没被调
    expect(await getBalance(userA)).toBe(before)
    // agent 契约：payload 转 snake（projectName → project_name，passedItems → passed_items）
    expect(captured.reportPayload!.project_name).toBe("招标文件.pdf·包件一")
    expect(captured.reportPayload!.passed_items).toEqual(["投标函格式符合要求"])
  })

  it("pdf 回落 docx：agent 返回 format=docx → filename 后缀如实 .docx", async () => {
    reportFormat = "docx" // agent 转换失败回落
    try {
      const res = await exportReport(tokenA, { ...REPORT_BODY, format: "pdf" })
      const body = (await res.json()) as { filename: string; format: string }
      expect(body.format).toBe("docx")
      expect(body.filename.endsWith(".docx")).toBe(true)
    } finally {
      reportFormat = null
    }
  })

  it("坏输入（items 元素缺 title）→ 400；agent 炸 → 502（都不触计费）", async () => {
    const calls = captured.preDeductCalls
    expect((await exportReport(tokenA, { ...REPORT_BODY, items: [{ level: "高" }] })).status).toBe(400)
    reportFail = true
    try {
      expect((await exportReport(tokenA, REPORT_BODY)).status).toBe(502)
    } finally {
      reportFail = false
    }
    expect(captured.preDeductCalls).toBe(calls)
  })
})

describe("POST /api/checklist/report/read 标书分析报告导出（免计费）", () => {
  const exportRead = (token: string, body: unknown) =>
    app.request("/api/checklist/report/read", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    })

  it("成功：服务端取存量 read 结果组载荷 → {url, filename 带项目基名}；不触计费", async () => {
    const calls = captured.preDeductCalls
    const [p] = await getDb().insert(bidProjects).values({
      userId: userA, threadId: `proj-${crypto.randomUUID()}`,
      tenderFileKey: "uploads/x/招标文件.pdf", name: "招标文件.pdf·包件一",
    }).returning()
    await getDb().insert(projectSteps).values({
      projectId: p!.id, step: "read", status: "done",
      result: { project_meta: { name: "统一认证项目", code: "ZB1" }, categories: [
        { key: "overview", title: "项目概况", items: [{ title: "项目名称", value: "统一认证项目" }] },
      ], risk_summary: ["红线1"] },
    } as never)
    const res = await exportRead(tokenA, { projectId: p!.id })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { url: string; filename: string }
    expect(body.filename).toBe("招标文件·包件一-标书分析报告.docx") // 内嵌 .pdf 扩展名被剥
    expect(body.url).toContain("artifacts/report/")
    expect(captured.preDeductCalls).toBe(calls) // 免费
    expect((captured.readPayload!.project_meta as { code: string }).code).toBe("ZB1")
    expect(captured.readPayload!.risk_summary).toEqual(["红线1"])
  })

  it("read 未完成 → 404 read_not_ready；他人项目 → 404；非 uuid → 400", async () => {
    const [p2] = await getDb().insert(bidProjects).values({
      userId: userA, threadId: `proj-${crypto.randomUUID()}`, tenderFileKey: null, name: "无读标项目",
    }).returning()
    expect((await exportRead(tokenA, { projectId: p2!.id })).status).toBe(404)
    expect((await exportRead(tokenB, { projectId: p2!.id })).status).toBe(404)
    expect((await exportRead(tokenA, { projectId: "not-a-uuid" })).status).toBe(400)
  })
})
