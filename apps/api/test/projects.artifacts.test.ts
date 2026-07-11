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
  // present 步：result 是 deck 本身（不含产物 key——pptx key 在 export 步的合并快照里可见）
  await getDb().insert(projectSteps).values({
    projectId,
    step: "present",
    status: "done",
    result: { slides: [], qa: [] },
  })
  // export 步：result 即 BiddingState.artifacts 合并快照（顶层 docx + pptx + pdf，e2e 实测形状）
  // pdf 由 spec323 best-effort 转换产出，本项目的转换假定成功（key 存在）
  await getDb().insert(projectSteps).values({
    projectId,
    step: "export",
    status: "done",
    result: { docx: "artifacts/t/bid.docx", pptx: "artifacts/t/present.pptx", pdf: "artifacts/t/bid.pdf" },
  })
})

afterAll(async () => {
  await getDb().delete(users).where(eq(users.id, userId))
  await closeDb()
})

const auth = () => ({ Authorization: `Bearer ${token}` })

describe("/api/projects/:id/artifacts/:kind", () => {
  it("pptx：从 export 步合并快照取 key 发预签名 URL", async () => {
    const res = await app.request(`/api/projects/${projectId}/artifacts/pptx`, { headers: auth() })
    expect(res.status).toBe(200)
    const { url } = (await res.json()) as { url: string }
    expect(url).toContain("artifacts/t/present.pptx")
    expect(presigned).toContain("artifacts/t/present.pptx")
  })

  it("docx：从 export 步合并快照取 key", async () => {
    const res = await app.request(`/api/projects/${projectId}/artifacts/docx`, { headers: auth() })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { url: string }).url).toContain("artifacts/t/bid.docx")
  })

  it("pdf：spec323 best-effort 转换产出，存在时同 docx/pptx 一样可预签名下载", async () => {
    const res = await app.request(`/api/projects/${projectId}/artifacts/pdf`, { headers: auth() })
    expect(res.status).toBe(200)
    const { url } = (await res.json()) as { url: string }
    expect(url).toContain("artifacts/t/bid.pdf")
    expect(presigned).toContain("artifacts/t/bid.pdf")
  })

  it("pdf 转换失败（artifacts 无 pdf key）→ 404，不影响 docx 仍可下载", async () => {
    const [p2] = await getDb()
      .insert(bidProjects)
      .values({ userId, threadId: `proj-${crypto.randomUUID()}` })
      .returning()
    await getDb()
      .insert(projectSteps)
      .values({
        projectId: p2!.id,
        step: "export",
        status: "done",
        result: { docx: "artifacts/t2/bid.docx" }, // pdf 转换失败：agent 只写了 docx
      })
    const noPdf = await app.request(`/api/projects/${p2!.id}/artifacts/pdf`, { headers: auth() })
    expect(noPdf.status).toBe(404)
    const stillDocx = await app.request(`/api/projects/${p2!.id}/artifacts/docx`, { headers: auth() })
    expect(stillDocx.status).toBe(200)
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
