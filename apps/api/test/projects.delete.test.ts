import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import { Hono } from "hono"
import { projectRoutes } from "../src/routes/projects"
import { seedConfigs } from "../src/services/config"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, bidProjects, projectSteps, projectFiles } from "../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连真库（跑法：./test-on-mbp.sh test/projects.delete.test.ts）

// DELETE /api/projects/:id（用户删标书,前端二次确认）：
// 有 running 步 → 409 拒删；成功删除级联清 steps；他人项目/非 uuid → 404。

const app = new Hono()
app.route("/api/projects", projectRoutes({}))

let tokenA = ""
let userA = ""
let tokenB = ""
let userB = ""

beforeAll(async () => {
  await seedConfigs()
  const a = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  tokenA = a.token
  userA = a.user.id
  const b = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  tokenB = b.token
  userB = b.user.id
})
afterAll(async () => {
  await getDb().delete(users).where(inArray(users.id, [userA, userB]))
  await closeDb()
})

const del = (id: string, token: string) =>
  app.request(`http://x/api/projects/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } })

async function mkProject(stepStatus: "done" | "running") {
  const [p] = await getDb()
    .insert(bidProjects)
    .values({ userId: userA, threadId: `proj-${crypto.randomUUID()}`, currentStep: "outline", status: "running" })
    .returning()
  await getDb().insert(projectSteps).values({ projectId: p!.id, step: "read", status: stepStatus, result: {} })
  return p!.id
}

describe("DELETE /api/projects/:id", () => {
  it("正常删除：200，项目与步骤行级联清除", async () => {
    const id = await mkProject("done")
    const res = await del(id, tokenA)
    expect(res.status).toBe(200)
    expect(await getDb().select().from(bidProjects).where(eq(bidProjects.id, id))).toHaveLength(0)
    expect(await getDb().select().from(projectSteps).where(eq(projectSteps.projectId, id))).toHaveLength(0)
  })

  it("有 running 步（生成中）→ 409 project_running，项目保留", async () => {
    const id = await mkProject("running")
    const res = await del(id, tokenA)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe("project_running")
    expect(await getDb().select().from(bidProjects).where(eq(bidProjects.id, id))).toHaveLength(1)
    await getDb().delete(bidProjects).where(eq(bidProjects.id, id)) // 清理
  })

  it("共享招标文件保护：克隆兄弟项目仍引用的 key 不删 project_files 行", async () => {
    const KEY = `uploads/shared/${crypto.randomUUID()}/t.docx`
    await getDb().insert(projectFiles).values({ userId: userA, bucket: "bidsaas", key: KEY, filename: "t.docx", contentType: "application/x", size: 1, status: "uploaded" as const })
    const mk = () => getDb().insert(bidProjects).values({ userId: userA, threadId: `proj-${crypto.randomUUID()}`, currentStep: "outline", status: "running", tenderFileKey: KEY, tenderFileKeys: [KEY] }).returning()
    const [a] = await mk()
    const [b] = await mk() // 克隆兄弟:共用同一 key
    expect((await del(a!.id, tokenA)).status).toBe(200)
    expect(await getDb().select().from(projectFiles).where(eq(projectFiles.key, KEY))).toHaveLength(1) // B 仍引用 → 保留
    expect((await del(b!.id, tokenA)).status).toBe(200)
    expect(await getDb().select().from(projectFiles).where(eq(projectFiles.key, KEY))).toHaveLength(0) // 无人引用 → 清除
  })

  it("他人项目 → 404 不可删；非 uuid → 404", async () => {
    const id = await mkProject("done")
    const res = await del(id, tokenB)
    expect(res.status).toBe(404)
    expect(await getDb().select().from(bidProjects).where(eq(bidProjects.id, id))).toHaveLength(1)
    expect((await del("not-a-uuid", tokenA)).status).toBe(404)
    await getDb().delete(bidProjects).where(eq(bidProjects.id, id))
  })
})
