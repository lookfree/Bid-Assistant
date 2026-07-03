import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { projectRoutes, type ProjectDeps } from "../src/routes/projects"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, bidProjects, projectSteps } from "../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS)

let token = ""
let userId = ""
let projectId = ""
const presigned: string[] = []

const mockDeps: Partial<ProjectDeps> = {
  presignGet: async (key: string) => {
    presigned.push(key)
    return `https://minio.example/${key}?sig=x`
  },
}

const app = new Hono()
app.route("/api/projects", projectRoutes(mockDeps))

beforeAll(async () => {
  const r = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  token = r.token
  userId = r.user.id
  const [p] = await getDb()
    .insert(bidProjects)
    .values({ userId, threadId: `proj-${crypto.randomUUID()}` })
    .returning()
  projectId = p!.id
  // present 步：result 顶层是 deck，产物在 artifacts 快照（spec201 step.done 契约）
  await getDb().insert(projectSteps).values({
    projectId,
    step: "present",
    status: "done",
    result: { slides: [], artifacts: { pptx: "artifacts/t/present.pptx" } },
  })
  // export 步：artifacts 合并快照含 docx + pptx
  await getDb().insert(projectSteps).values({
    projectId,
    step: "export",
    status: "done",
    result: { artifacts: { docx: "artifacts/t/bid.docx", pptx: "artifacts/t/present.pptx" } },
  })
})

afterAll(async () => {
  await getDb().delete(users).where(eq(users.id, userId))
  await closeDb()
})

const auth = () => ({ Authorization: `Bearer ${token}` })

describe("/api/projects/:id/artifacts/:kind", () => {
  it("pptx：从 present 步 result.artifacts 取 key 发预签名 URL", async () => {
    const res = await app.request(`/api/projects/${projectId}/artifacts/pptx`, { headers: auth() })
    expect(res.status).toBe(200)
    const { url } = (await res.json()) as { url: string }
    expect(url).toContain("artifacts/t/present.pptx")
    expect(presigned).toContain("artifacts/t/present.pptx")
  })

  it("docx：从 export 步 artifacts 合并快照取 key", async () => {
    const res = await app.request(`/api/projects/${projectId}/artifacts/docx`, { headers: auth() })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { url: string }).url).toContain("artifacts/t/bid.docx")
  })

  it("未知 kind → 400；无产物项目 → 404", async () => {
    const bad = await app.request(`/api/projects/${projectId}/artifacts/exe`, { headers: auth() })
    expect(bad.status).toBe(400)
    const [p2] = await getDb()
      .insert(bidProjects)
      .values({ userId, threadId: `proj-${crypto.randomUUID()}` })
      .returning()
    const none = await app.request(`/api/projects/${p2!.id}/artifacts/docx`, { headers: auth() })
    expect(none.status).toBe(404)
  })
})
