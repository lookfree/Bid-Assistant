import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { inArray } from "drizzle-orm"
import { Hono } from "hono"
import { projectRoutes } from "../src/routes/projects"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, bidProjects, projectFiles } from "../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连真库

// GET /api/projects 我的项目列表：属主隔离 / 分页 / name 解析 / step 进度
const app = new Hono()
app.route("/api/projects", projectRoutes())

let tokenA = ""
let userA = ""
let tokenB = ""
let userB = ""

type Item = { id: string; name: string; status: string; currentStep: string; stepIndex: number; totalSteps: number; createdAt: string }
type Body = { items: Item[]; page: number; pageSize: number; total: number; hasMore: boolean }

beforeAll(async () => {
  const a = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  tokenA = a.token
  userA = a.user.id
  const b = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  tokenB = b.token
  userB = b.user.id

  // A 三个项目（顺序插入保证 createdAt 递增）：中文文件名（老数据无 name，兜底 basename）/ 无文件 / 整本 done
  await getDb().insert(bidProjects).values({
    userId: userA,
    threadId: `proj-${crypto.randomUUID()}`,
    tenderFileKey: `uploads/${userA}/${crypto.randomUUID()}/招标文件.pdf`,
  })
  await getDb().insert(bidProjects).values({ userId: userA, threadId: `proj-${crypto.randomUUID()}` })
  await getDb().insert(bidProjects).values({
    userId: userA,
    threadId: `proj-${crypto.randomUUID()}`,
    tenderFileKey: `uploads/${userA}/${crypto.randomUUID()}/done.pdf`,
    status: "done",
    currentStep: "done",
  })
  // B 一个项目（验证 A 看不到）
  await getDb().insert(bidProjects).values({
    userId: userB,
    threadId: `proj-${crypto.randomUUID()}`,
    tenderFileKey: `uploads/${userB}/${crypto.randomUUID()}/b.pdf`,
  })
})

afterAll(async () => {
  await getDb().delete(users).where(inArray(users.id, [userA, userB])) // 项目随 user 级联删
  await closeDb()
})

const get = (path: string, token: string) => app.request(path, { headers: { Authorization: `Bearer ${token}` } })

describe("GET /api/projects 我的项目列表", () => {
  it("只返回自己的项目，按 createdAt 倒序，name/进度解析正确", async () => {
    const res = await get("/api/projects", tokenA)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Body
    expect(body.total).toBe(3)
    expect(body.items.length).toBe(3)
    // 属主隔离：不含 B 的项目
    expect(body.items.every((i) => i.name !== "b.pdf")).toBe(true)

    // 倒序：最后插入的 done 项目排最前
    const [done, unnamed, legacy] = body.items
    expect(done!.status).toBe("done")
    expect(done!.currentStep).toBe("done")
    expect(done!.stepIndex).toBe(6) // done → 打满
    expect(done!.totalSteps).toBe(6)

    // 无 tenderFileKey → 兜底名；draft 起步 stepIndex=0
    expect(unnamed!.name).toBe("未命名项目")
    expect(unnamed!.stepIndex).toBe(0)
    expect(unnamed!.currentStep).toBe("read")

    // 无 name 的老数据兜底 key basename（不做 decodeURIComponent——上传链路从不 URI 编码）
    expect(legacy!.name).toBe("招标文件.pdf")
    expect(legacy!.createdAt).toBeTruthy()
  })

  it("分页：pageSize=2 两页取完，hasMore 正确", async () => {
    const p1 = (await (await get("/api/projects?page=1&pageSize=2", tokenA)).json()) as Body
    expect(p1.items.length).toBe(2)
    expect(p1.hasMore).toBe(true)
    const p2 = (await (await get("/api/projects?page=2&pageSize=2", tokenA)).json()) as Body
    expect(p2.items.length).toBe(1)
    expect(p2.hasMore).toBe(false)
    // 两页无重叠
    const ids = new Set([...p1.items, ...p2.items].map((i) => i.id))
    expect(ids.size).toBe(3)
  })

  it("非法分页参数 → 400；未登录 → 401", async () => {
    const bad = await get("/api/projects?page=0", tokenA)
    expect(bad.status).toBe(400)
    const anon = await app.request("/api/projects")
    expect(anon.status).toBe(401)
  })

  it("B 只见自己的一个项目", async () => {
    const body = (await (await get("/api/projects", tokenB)).json()) as Body
    expect(body.total).toBe(1)
    expect(body.items[0]!.name).toBe("b.pdf")
  })

  it("POST 建项目后列表 name=上传时的原始 filename（非 key 反解）", async () => {
    // 模拟上传链路：project_files 存原始 filename，key 里是 sanitize 后的名（空格/括号被替换）
    const original = "我的 投标(终版).pdf"
    const key = `uploads/${userA}/${crypto.randomUUID()}/我的_投标_终版_.pdf`
    await getDb().insert(projectFiles).values({
      userId: userA,
      bucket: "bidsaas",
      key,
      filename: original,
      contentType: "application/pdf",
      size: 1,
      status: "uploaded",
    })
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
      body: JSON.stringify({ fileKey: key }),
    })
    expect(res.status).toBe(200)

    const body = (await (await get("/api/projects", tokenA)).json()) as Body
    expect(body.total).toBe(4)
    expect(body.items[0]!.name).toBe(original) // 落库 name 优先，非 sanitize 后的 basename
  })
})
