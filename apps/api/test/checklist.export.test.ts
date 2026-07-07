import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { inArray } from "drizzle-orm"
import { Hono } from "hono"
import { checklistRoutes, type ChecklistDeps } from "../src/routes/checklist"
import * as billing from "../src/services/billing-stub"
import { grant, getBalance } from "../src/services/credits"
import { seedConfigs, setConfig } from "../src/services/config"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users } from "../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连真库（钱路径走真账本，只 mock agent client / presign）

// POST /api/checklist/export 导出计费全路径（spec315b 契约 4）：
// hold(export=20) → agent 渲染 → 预签名 → settle 足额；agent 失败 settleFailed 净 0 → 502；余额不足 402。

let agentFail = false
let presignFail = false
let settleError: Error | null = null
const captured: {
  preDeductCalls: number
  payload?: Parameters<ChecklistDeps["renderChecklist"]>[0]
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

beforeAll(async () => {
  await seedConfigs()
  await setConfig("credit_cost.export", 20) // 钉死口径，与环境解耦
  const a = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  tokenA = a.token
  userA = a.user.id
  await grant(userA, 100, { idempotencyKey: `g-cl-export-${userA}` })
  const b = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  tokenB = b.token
  userB = b.user.id // 不授信 → 余额 0
})

afterAll(async () => {
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
