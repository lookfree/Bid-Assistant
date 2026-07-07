import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import { Hono } from "hono"
import { dedupeRoutes, type DedupeDeps } from "../src/routes/dedupe"
import * as billing from "../src/services/billing-stub"
import { AgentHttpError } from "../src/services/agent-client"
import { grant, getBalance } from "../src/services/credits"
import { seedConfigs, setConfig } from "../src/services/config"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, projectFiles, dedupeRuns } from "../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连真库（钱路径走真账本，只 mock agent client）

// POST /api/dedupe 查重计费全路径（spec315b 契约 3）：
// hold(dedupe=100) → agent → settle 足额 → 审计行；他人 fileKey 400 不扣钱；agent 失败净 0；402 无残留。

let agentError: Error | null = null
let settleError: Error | null = null
const captured: {
  preDeductCalls: number
  payload?: Parameters<DedupeDeps["dedupe"]>[0]
} = { preDeductCalls: 0 }

// agent /dedupe 响应（snake_case 原样，spec315b agent 契约 2 的形状）
const AGENT_RESULT = {
  pairs: [
    {
      a: "A公司投标.docx",
      b: "B公司投标.docx",
      score: 68,
      tone: "warning",
      note: "文本高度相似",
      hits: [{ dim: "text", a_text: "本项目工期为 90 日历天", b_text: "本项目工期为 90 日历天", detail: "Jaccard 0.82" }],
    },
  ],
  overall: { max_score: 68, high_pairs: 0 },
  dims_run: ["text", "meta"],
}

// 钱走真账本（billing-stub → credits 真实现）；仅包一层计数供「不触计费」断言
const mockDeps: Partial<DedupeDeps> = {
  preDeduct: async (userId, op, ref) => {
    captured.preDeductCalls++
    return billing.preDeduct(userId, op, ref)
  },
  dedupe: async (payload) => {
    captured.payload = payload
    if (agentError) throw agentError
    return AGENT_RESULT
  },
  settle: async (ref, holdId, actualCost) => {
    if (settleError) throw settleError
    return billing.settle(ref, holdId, actualCost)
  },
}

const app = new Hono()
app.route("/api/dedupe", dedupeRoutes(mockDeps))

let tokenA = ""
let userA = ""
let tokenB = ""
let userB = ""
let keyA1 = "" // A 的已上传文件
let keyA2 = ""
let tenderA = "" // A 的招标文件
let keyB = "" // B 的文件（A 引用它必须 400）
let keyPending = "" // A 的未完成上传文件（status=pending）

/** 直插一条 project_files（绕过三段直传，测试只关心属主与状态）。 */
async function makeFile(userId: string, filename: string, status: "pending" | "uploaded" = "uploaded") {
  const [f] = await getDb()
    .insert(projectFiles)
    .values({
      userId,
      bucket: "bidsaas",
      key: `dedupe-test/${crypto.randomUUID()}/${filename}`,
      filename,
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      size: 1024,
      status,
    })
    .returning()
  return f!.key
}

beforeAll(async () => {
  await seedConfigs()
  await setConfig("credit_cost.dedupe", 100) // 钉死口径，与环境解耦
  const a = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  tokenA = a.token
  userA = a.user.id
  await grant(userA, 200, { idempotencyKey: `g-dedupe-${userA}` })
  const b = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  tokenB = b.token
  userB = b.user.id // 不授信 → 余额 0

  keyA1 = await makeFile(userA, "A公司投标.docx")
  keyA2 = await makeFile(userA, "B公司投标.docx")
  tenderA = await makeFile(userA, "招标文件.docx")
  keyPending = await makeFile(userA, "未传完.docx", "pending")
  keyB = await makeFile(userB, "别人的.docx")
})

afterAll(async () => {
  await getDb().delete(users).where(inArray(users.id, [userA, userB])) // 文件/账本/审计行随 user 级联删
  await closeDb()
})

const dedupe = (token: string, body: unknown) =>
  app.request("/api/dedupe", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })

const auditRows = (userId: string) => getDb().select().from(dedupeRuns).where(eq(dedupeRuns.userId, userId))

describe("POST /api/dedupe 标书查重（真账本）", () => {
  it("① 成功：扣 100、结果 snake→camel、审计行落库、agent 载荷带 label/tender_key", async () => {
    const req = { fileKeys: [keyA1, keyA2], tenderKey: tenderA, dims: ["text", "meta", "baseline"], strategy: "standard" }
    const res = await dedupe(tokenA, req)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      pairs: Array<{ a: string; score: number; hits: Array<Record<string, unknown>> }>
      overall: { maxScore: number; highPairs: number }
      dimsRun: string[]
    }
    // agent 结果原样返回，仅 snake→camel（a_text→aText / max_score→maxScore / dims_run→dimsRun）
    expect(body.overall).toEqual({ maxScore: 68, highPairs: 0 })
    expect(body.dimsRun).toEqual(["text", "meta"])
    expect(body.pairs[0]!.hits[0]!.aText).toBe("本项目工期为 90 日历天")
    expect("a_text" in body.pairs[0]!.hits[0]!).toBe(false)

    // 余额 200 → 100（hold 100 → settle 足额）
    expect(await getBalance(userA)).toBe(100)

    // agent 载荷契约：files 带上传原始文件名 label；tenderKey/dims/strategy 透传
    expect(captured.payload).toEqual({
      files: [
        { key: keyA1, label: "A公司投标.docx" },
        { key: keyA2, label: "B公司投标.docx" },
      ],
      tenderKey: tenderA,
      dims: ["text", "meta", "baseline"],
      strategy: "standard",
    })

    // 审计行：params=请求参数、result=agent 原样（snake）、cost=100
    const rows = await auditRows(userA)
    expect(rows.length).toBe(1)
    expect(rows[0]!.cost).toBe(100)
    expect(rows[0]!.params).toEqual(req)
    expect((rows[0]!.result as typeof AGENT_RESULT).overall).toEqual({ max_score: 68, high_pairs: 0 })
  })

  it("② 他人 fileKey / pending 文件 / 他人 tenderKey：400 invalid_files 且不触计费", async () => {
    const calls = captured.preDeductCalls
    const before = await getBalance(userA)
    for (const body of [
      { fileKeys: [keyA1, keyB], dims: ["text"], strategy: "fast" }, // 混入 B 的文件
      { fileKeys: [keyA1, keyPending], dims: ["text"], strategy: "fast" }, // 未完成上传
      { fileKeys: [keyA1, keyA2], tenderKey: keyB, dims: ["text"], strategy: "fast" }, // tenderKey 也校验属主
      { fileKeys: [keyA1, `dedupe-test/${crypto.randomUUID()}/ghost.docx`], dims: ["text"], strategy: "fast" }, // 不存在
    ]) {
      const res = await dedupe(tokenA, body)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe("invalid_files")
    }
    expect(captured.preDeductCalls).toBe(calls) // 预扣根本没被调
    expect(await getBalance(userA)).toBe(before)
    expect((await auditRows(userA)).length).toBe(1) // 无新审计行
  })

  it("③ agent 抛错：settleFailed 净 0、502 agent_failed、无审计行", async () => {
    agentError = new Error("agent boom")
    try {
      const before = await getBalance(userA)
      const res = await dedupe(tokenA, { fileKeys: [keyA1, keyA2], dims: ["text"], strategy: "strict" })
      expect(res.status).toBe(502)
      expect(((await res.json()) as { error: string }).error).toBe("agent_failed")
      expect(await getBalance(userA)).toBe(before) // hold 全额退还，净 0
      expect((await auditRows(userA)).length).toBe(1)
    } finally {
      agentError = null
    }
  })

  it("③b agent 422（某文件解析失败）：退钱净 0 且 422 body 透传", async () => {
    agentError = new AgentHttpError(422, { error: "parse_failed", file: "B公司投标.docx" })
    try {
      const before = await getBalance(userA)
      const res = await dedupe(tokenA, { fileKeys: [keyA1, keyA2], dims: ["text"], strategy: "fast" })
      expect(res.status).toBe(422)
      expect(await res.json()).toEqual({ error: "parse_failed", file: "B公司投标.docx" })
      expect(await getBalance(userA)).toBe(before) // 解析失败也全额退还
    } finally {
      agentError = null
    }
  })

  it("③c settle 抛错：结果已交付仍 200，不退款（余额已扣 100，宁少收不多收）", async () => {
    settleError = new Error("settle boom")
    try {
      const before = await getBalance(userA)
      const auditBefore = (await auditRows(userA)).length
      const res = await dedupe(tokenA, { fileKeys: [keyA1, keyA2], dims: ["text"], strategy: "standard" })
      expect(res.status).toBe(200) // 结果照常交付
      const body = (await res.json()) as { overall: { maxScore: number } }
      expect(body.overall.maxScore).toBe(68)
      expect(await getBalance(userA)).toBe(before - 100) // hold 已扣不退（settle 失败只记日志待对账）
      const rows = await auditRows(userA)
      expect(rows.length).toBe(auditBefore + 1) // 审计行照落，cost 记预扣额
      expect(rows[rows.length - 1]!.cost).toBe(100)
    } finally {
      settleError = null
    }
  })

  it("④ 余额不足：402 insufficient 无残留（余额 0、无审计行）", async () => {
    const k1 = await makeFile(userB, "b1.docx")
    const k2 = await makeFile(userB, "b2.docx")
    const res = await dedupe(tokenB, { fileKeys: [k1, k2], dims: ["text"], strategy: "standard" })
    expect(res.status).toBe(402)
    expect(((await res.json()) as { error: string }).error).toBe("insufficient")
    expect(await getBalance(userB)).toBe(0) // preDeduct 余额不足即拒，无扣减/挂起 hold
    expect((await auditRows(userB)).length).toBe(0)
  })

  it("⑤ 坏输入：fileKeys 少于 2 / 超过 3 / 非法 dim / 非法 strategy → 400 不触计费", async () => {
    const calls = captured.preDeductCalls
    expect((await dedupe(tokenA, { fileKeys: [keyA1], dims: ["text"], strategy: "fast" })).status).toBe(400)
    expect((await dedupe(tokenA, { fileKeys: [keyA1, keyA2, tenderA, keyA1], dims: ["text"], strategy: "fast" })).status).toBe(400)
    expect((await dedupe(tokenA, { fileKeys: [keyA1, keyA2], dims: ["magic"], strategy: "fast" })).status).toBe(400)
    expect((await dedupe(tokenA, { fileKeys: [keyA1, keyA2], dims: ["text"], strategy: "turbo" })).status).toBe(400)
    expect(captured.preDeductCalls).toBe(calls)
  })

  it("⑥ fileKeys 自比：重复 fileKey / tenderKey 混入 fileKeys → 400 invalid_files 不触计费", async () => {
    const calls = captured.preDeductCalls
    for (const body of [
      { fileKeys: [keyA1, keyA1], dims: ["text"], strategy: "fast" }, // 同一文件自比
      { fileKeys: [keyA1, keyA2, keyA2], dims: ["text"], strategy: "fast" }, // 三份里两份重复
      { fileKeys: [keyA1, keyA2], tenderKey: keyA1, dims: ["text", "baseline"], strategy: "fast" }, // 基线=投标文件
    ]) {
      const res = await dedupe(tokenA, body)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe("invalid_files")
    }
    expect(captured.preDeductCalls).toBe(calls) // 预扣根本没被调
  })
})
