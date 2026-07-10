import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { libraryRoutes, type LibraryDeps } from "../src/routes/library"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, libraryItems } from "../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连真库（鉴权/CRUD 走真库，agent 侧 mock）

// spec316：library CRUD 的 best-effort RAG 索引钩子 + 手动重建 reindex。
// 核心不变式：agent 抛错时 CRUD 响应必须仍是成功状态（best-effort 绝不阻塞/污染响应）。

let token = ""
let userId = ""
let indexFails = false // 置 true 让 mock ragIndex 抛错，验证响应不受影响
const captured: {
  indexCalls: Array<Parameters<LibraryDeps["ragIndex"]>[0]>
  deleteCalls: Array<Parameters<LibraryDeps["ragDelete"]>[0]>
} = { indexCalls: [], deleteCalls: [] }

const mockDeps: Partial<LibraryDeps> = {
  ragIndex: async (opts) => {
    captured.indexCalls.push(opts)
    if (indexFails) throw new Error("agent rag index boom")
  },
  ragDelete: async (opts) => {
    captured.deleteCalls.push(opts)
    throw new Error("agent rag delete boom") // 恒抛错：验证 DELETE 响应不受影响
  },
}

const app = new Hono()
app.route("/api/library", libraryRoutes(mockDeps))

beforeAll(async () => {
  const r = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  token = r.token
  userId = r.user.id
})

afterAll(async () => {
  await getDb().delete(users).where(eq(users.id, userId)) // 条目随 user 级联删
  await closeDb()
})

const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" }
const req = (path: string, init: RequestInit = {}) => app.request(`/api/library${path}`, { ...init, headers })

type Item = { id: string }

describe("/api/library RAG 索引钩子（spec316）", () => {
  let itemId = ""

  it("POST 建条目成功后触发 ragIndex（参数正确）", async () => {
    const res = await req("", {
      method: "POST",
      body: JSON.stringify({
        category: "qualification",
        title: "ISO27001 认证",
        meta: "证书编号 CN-2025-001",
        fields: [{ label: "发证机构", value: "CNAS" }],
        body: "证书说明正文",
      }),
    })
    expect(res.status).toBe(201)
    const row = (await res.json()) as Item
    itemId = row.id

    expect(captured.indexCalls).toHaveLength(1)
    const call = captured.indexCalls[0]!
    expect(call.userId).toBe(userId)
    expect(call.sourceId).toBe(itemId)
    expect(call.title).toBe("ISO27001 认证")
    expect(call.text).toContain("ISO27001 认证")
    expect(call.text).toContain("证书编号 CN-2025-001")
    expect(call.text).toContain("发证机构：CNAS")
    expect(call.text).toContain("证书说明正文")
  })

  it("POST 时 agent 抛错 → best-effort 不影响响应，仍 201", async () => {
    indexFails = true
    try {
      const before = captured.indexCalls.length
      const res = await req("", { method: "POST", body: JSON.stringify({ category: "text", title: "会抛错的条目" }) })
      expect(res.status).toBe(201) // 核心断言：agent 失败不改变 CRUD 响应
      expect(captured.indexCalls.length).toBe(before + 1) // 仍尝试调用过
    } finally {
      indexFails = false
    }
  })

  it("PUT 更新条目成功后触发 ragIndex（重建该条向量）", async () => {
    const before = captured.indexCalls.length
    const res = await req(`/${itemId}`, { method: "PUT", body: JSON.stringify({ title: "ISO27001 信息安全认证" }) })
    expect(res.status).toBe(200)
    expect(captured.indexCalls.length).toBe(before + 1)
    const call = captured.indexCalls.at(-1)!
    expect(call.sourceId).toBe(itemId)
    expect(call.title).toBe("ISO27001 信息安全认证")
  })

  it("PUT 时 agent 抛错 → best-effort 不影响响应，仍 200", async () => {
    indexFails = true
    try {
      const res = await req(`/${itemId}`, { method: "PUT", body: JSON.stringify({ title: "再改一次" }) })
      expect(res.status).toBe(200)
    } finally {
      indexFails = false
    }
  })

  it("DELETE 删条目成功后触发 ragDelete；agent 抛错不影响响应（恒 200）", async () => {
    const res = await req(`/${itemId}`, { method: "DELETE" })
    expect(res.status).toBe(200) // mock ragDelete 恒抛错，响应仍是删除成功
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true)
    expect(captured.deleteCalls).toHaveLength(1)
    expect(captured.deleteCalls[0]).toEqual({ userId, sourceType: "library", sourceId: itemId })
  })
})

describe("POST /api/library/reindex（spec316 手动重建）", () => {
  let otherUserId = ""
  let otherToken = ""

  beforeAll(async () => {
    const o = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
    otherToken = o.token
    otherUserId = o.user.id
    // 直插两条属于本用户的条目 + 一条属于另一用户的条目
    await getDb()
      .insert(libraryItems)
      .values([
        { userId, category: "text", title: "条目一", body: "正文一" },
        { userId, category: "text", title: "条目二", body: "正文二" },
        { userId: otherUserId, category: "text", title: "别人的条目" },
      ])
  })

  afterAll(async () => {
    await getDb().delete(users).where(eq(users.id, otherUserId))
  })

  it("遍历本人全部条目逐条 best-effort ragIndex，返回 {reindexed: n}；属主隔离不碰他人条目", async () => {
    captured.indexCalls = []
    // 期望值不写死：本用户在前一套 CRUD 测试里可能留有条目（会抛错的条目未被删），直接以 DB 现存条数为准
    const mine = await getDb().select({ id: libraryItems.id }).from(libraryItems).where(eq(libraryItems.userId, userId))
    const res = await app.request("/api/library/reindex", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { reindexed: number }
    expect(body.reindexed).toBe(mine.length)
    expect(captured.indexCalls).toHaveLength(mine.length)
    expect(captured.indexCalls.every((c) => c.userId === userId)).toBe(true)
    expect(captured.indexCalls.some((c) => c.title === "别人的条目")).toBe(false)
  })

  it("未登录 → 401", async () => {
    const res = await app.request("/api/library/reindex", { method: "POST" })
    expect(res.status).toBe(401)
  })
})
