import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import { Hono } from "hono"
import { feedbackRoutes } from "../src/routes/feedback"
import { adminRoutes } from "../src/routes/admin"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, feedback, adminUsers, adminAuditLogs } from "../src/db/schema"
import { uniquePhone, makeAdminSession, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程真库（跑法：./test-on-mbp.sh test/feedback.test.ts）

// spec326 契约 A：反馈/投诉——C 端提交/查看 + admin 处理，money-blind、审计可追溯。
const app = new Hono()
app.route("/api/feedback", feedbackRoutes())
app.route("/admin-api", adminRoutes())

let tokenA = ""
let userA = ""
let tokenB = ""
let userB = ""
const madeUsers: string[] = []
const madeAdmins: string[] = []
const regUser = (id: string) => madeUsers.push(id)
const regAdmin = (id: string) => madeAdmins.push(id)

beforeAll(async () => {
  const a = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  tokenA = a.token
  userA = a.user.id
  regUser(userA)
  const b = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  tokenB = b.token
  userB = b.user.id
  regUser(userB)
})

afterAll(async () => {
  await getDb().delete(users).where(inArray(users.id, madeUsers)) // feedback 行随 user 级联删
  await getDb().delete(adminUsers).where(inArray(adminUsers.id, madeAdmins))
  await closeDb()
})

const postFeedback = (token: string, body: unknown) =>
  app.request("http://x/api/feedback", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })

const getFeedback = (token?: string) =>
  app.request("http://x/api/feedback", { headers: token ? { Authorization: `Bearer ${token}` } : {} })

let feedbackIdA = ""

describe("POST/GET /api/feedback（C 端反馈）", () => {
  it("① 合法提交 → 201，行字段正确（status=pending）", async () => {
    const res = await postFeedback(tokenA, { type: "complaint", content: "页面加载很慢" })
    expect(res.status).toBe(201)
    const row = (await res.json()) as Record<string, unknown>
    expect(row.status).toBe("pending")
    expect(row.type).toBe("complaint")
    expect(row.userId).toBe(userA)
    feedbackIdA = row.id as string
  })

  it("② 非法输入 400；未带 token 401", async () => {
    expect((await postFeedback(tokenA, { type: "not-a-type", content: "x" })).status).toBe(400)
    expect((await postFeedback(tokenA, { type: "complaint", content: "" })).status).toBe(400)
    expect((await postFeedback(tokenA, { type: "complaint", content: "长".repeat(2001) })).status).toBe(400)
    expect((await getFeedback()).status).toBe(401)
  })

  it("③ GET 只见本人：A 建的一条不出现在 B 的列表里", async () => {
    const marker = `only-for-A-${Date.now()}`
    await postFeedback(tokenA, { type: "suggestion", content: marker })
    const itemsB = ((await (await getFeedback(tokenB)).json()) as { items: { content: string }[] }).items
    expect(itemsB.some((i) => i.content === marker)).toBe(false)
    const itemsA = ((await (await getFeedback(tokenA)).json()) as { items: { content: string }[] }).items
    expect(itemsA.some((i) => i.content === marker)).toBe(true)
  })

  it("④ 日限：本人当日已有 ≥20 条时再提交 → 429", async () => {
    const c = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
    regUser(c.user.id)
    await getDb()
      .insert(feedback)
      .values(Array.from({ length: 20 }, (_, i) => ({ userId: c.user.id, type: "other" as const, content: `filler-${i}` })))
    const res = await postFeedback(c.token, { type: "other", content: "one more" })
    expect(res.status).toBe(429)
    expect(((await res.json()) as { error: string }).error).toBe("too_many_feedback")
  })
})

const adminGetFeedback = (headers: Record<string, string>, query = "") =>
  app.request(`http://x/admin-api/feedback${query}`, { headers })

const adminPatchFeedback = (headers: Record<string, string>, id: string, body: unknown) =>
  app.request(`http://x/admin-api/feedback/${id}`, { method: "PATCH", headers, body: JSON.stringify(body) })

describe("GET/PATCH /admin-api/feedback（admin 处理）", () => {
  it("⑤ admin GET：可按 status 筛选、分页字段形状正确；finance 角色 403", async () => {
    const { headers } = await makeAdminSession("support", regAdmin)
    const res = await adminGetFeedback(headers, "?status=pending&page=1&pageSize=20")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: unknown[]; total: number; page: number; pageSize: number; hasMore: boolean }
    expect(body.page).toBe(1)
    expect(body.pageSize).toBe(20)
    expect(typeof body.total).toBe("number")
    expect(typeof body.hasMore).toBe("boolean")
    expect(body.items.every((i) => (i as { status: string }).status === "pending")).toBe(true)
    expect(body.items.some((i) => "nickname" in (i as object))).toBe(true)

    const { headers: financeHeaders } = await makeAdminSession("finance", regAdmin)
    expect((await adminGetFeedback(financeHeaders)).status).toBe(403)
  })

  it("⑥ admin PATCH：support 可改 → 200，字段落库正确；不存在 id 404；写审计", async () => {
    const { headers, adminId } = await makeAdminSession("support", regAdmin)
    const [admin] = await getDb().select().from(adminUsers).where(eq(adminUsers.id, adminId))
    const res = await adminPatchFeedback(headers, feedbackIdA, { status: "resolved", reply: "已修复，感谢反馈" })
    expect(res.status).toBe(200)
    const row = (await res.json()) as Record<string, unknown>
    expect(row.status).toBe("resolved")
    expect(row.reply).toBe("已修复，感谢反馈")
    expect(row.handledBy).toBe(admin!.username)
    expect(row.handledAt).not.toBeNull()

    expect((await adminPatchFeedback(headers, "00000000-0000-0000-0000-000000000000", { status: "resolved" })).status).toBe(404)

    const logs = await getDb()
      .select()
      .from(adminAuditLogs)
      .where(inArray(adminAuditLogs.action, ["feedback.handle"]))
    expect(logs.some((l) => l.target === `feedback:${feedbackIdA}`)).toBe(true)
  })

  it("⑦ C 端 GET 能看到 admin 的处理结果", async () => {
    const itemsA = ((await (await getFeedback(tokenA)).json()) as { items: { id: string; status: string; reply: string }[] }).items
    const row = itemsA.find((i) => i.id === feedbackIdA)
    expect(row?.status).toBe("resolved")
    expect(row?.reply).toBe("已修复，感谢反馈")
  })
})
