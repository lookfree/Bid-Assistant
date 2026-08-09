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
  const r = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => "ok" as const)
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
  // docx_tech：2026-08-09 export-scope 分册产物键（与全量键并存，见 nodes/export.py 的合并通道）
  await getDb().insert(projectSteps).values({
    projectId,
    step: "export",
    status: "done",
    result: {
      docx: "artifacts/t/bid.docx",
      pptx: "artifacts/t/present.pptx",
      pdf: "artifacts/t/bid.pdf",
      docx_tech: "artifacts/t/bid_tech.docx",
    },
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

  it("分册键 docx_tech：ARTIFACT_NAME 认得(2026-08-09 export-scope)，与全量 docx 并存不冲突", async () => {
    const res = await app.request(`/api/projects/${projectId}/artifacts/docx_tech`, { headers: auth() })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { url: string }).url).toContain("artifacts/t/bid_tech.docx")
  })

  it("空墓碑保全（终审 wave2）：两行 export 快照，新行 pdf_tech=null → 404，不发旧行残留的旧文件", async () => {
    const [p3] = await getDb()
      .insert(bidProjects)
      .values({ userId, threadId: `proj-${crypto.randomUUID()}` })
      .returning()
    // 旧行：pdf_tech 转换曾经成功过，快照里还留着字符串 key
    await getDb().insert(projectSteps).values({
      projectId: p3!.id,
      step: "export",
      status: "done",
      result: { docx_tech: "artifacts/t3/bid_tech.docx", pdf_tech: "artifacts/t3/bid_tech-old.pdf" },
      createdAt: new Date(Date.now() - 60_000),
    })
    // 新行（最近一次重新导出）：本次 docx→pdf 转换失败，agent 显式把 pdf_tech 置空作废旧文件
    await getDb().insert(projectSteps).values({
      projectId: p3!.id,
      step: "export",
      status: "done",
      result: { docx_tech: "artifacts/t3/bid_tech.docx", pdf_tech: null },
      createdAt: new Date(),
    })
    const res = await app.request(`/api/projects/${p3!.id}/artifacts/pdf_tech`, { headers: auth() })
    expect(res.status).toBe(404) // 不该顶替发出旧行的字符串 key
    // docx_tech 两行都是同值字符串，仍应正常可下载（回归：本次修复不误伤仍有效的产物）
    const docx = await app.request(`/api/projects/${p3!.id}/artifacts/docx_tech`, { headers: auth() })
    expect(docx.status).toBe(200)
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
