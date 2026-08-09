import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout, mock } from "bun:test"
import { and, eq, inArray } from "drizzle-orm"
import { Hono } from "hono"
import type { ProjectDeps } from "../src/routes/projects"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, projectFiles, libraryItems, projectSteps } from "../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB

// 审查修正（2026-08-09，Task 4 补丁）：POST /:id/refresh-credentials-appendix 里，content result
// 的 sys-creds 键已经在前一个事务成功落库之后，才轮到「outline 无则补章」（syncCredentialsOutline）
// 这一步——它只是锦上添花，outline 没同步上，下一次 content 收尾钩子也会补上。绝不该让它的瞬时
// 失败（DB 抖动等）把已经成功的正文更新变成一个非契约的失败响应，诱导用户误以为要重试。
//
// 用 mock.module 把 syncCredentialsOutline 换成必抛错的实现，钉住「抛错也 200 {html}、content
// 已更新，但 outline 因为补章没跑成而不含 sys-creds」——outline 是否含 sys-creds 是判断 mock
// 真的生效了（而不是巧合地正常跑通）的关键信号，比单纯断言 200 更有说服力。
//
// 必须放独立文件：mock.module 要在本文件第一次 import routes/projects.ts 之前完成替换
// （ESM 静态 import 先于其它语句求值），与已经在文件顶部静态 import 过 projectRoutes 的
// credentials-chapter.test.ts 没法共用同一个模块图。
mock.module("../src/services/credentials-chapter", () => ({
  SYS_CREDS_ID: "sys-creds",
  buildCredentialsChapterHtml: (credentials: { title: string }[]) =>
    credentials.length ? credentials.map((c) => `<h3>${c.title}</h3>`).join("\n") : "",
  syncCredentialsOutline: async () => {
    throw new Error("模拟 DB 抖动：outline 补章瞬时失败")
  },
}))

const { projectRoutes } = await import("../src/routes/projects")

let token = ""
let userId = ""
let keyA = ""
let projectId = ""

const STEP_RESULTS: Record<string, unknown> = {
  read: { categories: [], doc_sections: [] },
  outline: { chapters: [{ id: "ch-1", no: "一", title: "技术方案", group: "tech", items: [] }] },
  content: { "ch-1": "<p>正文</p>" },
}
let runStep = ""

const mockDeps: Partial<ProjectDeps> = {
  resolveStepHoldAmount: async (step: string) => (step === "content" ? 260 : undefined),
  preDeduct: async () => ({ ok: true, holdId: "hold-x", hold: 10 }),
  settle: async (_ref, _holdId, actualCost) => actualCost,
  settleContent: async (_ref, _holdId, heldAmount) => heldAmount,
  settleFailed: async () => {},
  createRun: async (opts) => {
    const input = opts.input as { step: string }
    runStep = input.step
    return { run_id: crypto.randomUUID() }
  },
  relayStream: async function* () {
    yield "data: 进度\n\n"
  },
  getRun: async () => ({ status: "succeeded", result: STEP_RESULTS[runStep] }),
  getAgentModel: async () => ({
    provider: "deepseek", model: "deepseek-chat", fallbacks: "",
    params: { temperature: 0.7, max_tokens: 8192, top_p: 1 },
    chain: [{ provider: "deepseek", model: "deepseek-chat" }],
  }),
}

const app = new Hono()
app.route("/api/projects", projectRoutes(mockDeps))
const auth = (t: string) => ({ Authorization: `Bearer ${t}`, "content-type": "application/json" })

beforeAll(async () => {
  const a = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => "ok" as const)
  token = a.token
  userId = a.user.id

  keyA = `uploads/${userId}/${crypto.randomUUID()}/招标文件.pdf`
  await getDb()
    .insert(projectFiles)
    .values({ userId, bucket: "bidsaas", key: keyA, filename: "招标文件.pdf", contentType: "application/pdf", size: 1, status: "uploaded" })

  const [pngFile] = await getDb()
    .insert(projectFiles)
    .values({
      userId, bucket: "bidsaas", key: `uploads/${userId}/${crypto.randomUUID()}/营业执照.png`,
      filename: "营业执照.png", contentType: "image/png", size: 1, status: "uploaded",
    })
    .returning()
  await getDb()
    .insert(libraryItems)
    .values({ userId, category: "qualification", title: "营业执照", attachments: [{ fileId: pngFile!.id, name: "营业执照.png" }] })

  const created = await app.request("/api/projects", { method: "POST", headers: auth(token), body: JSON.stringify({ fileKey: keyA }) })
  expect(created.status).toBe(200)
  projectId = ((await created.json()) as { id: string }).id
  for (const step of ["read", "outline", "content"] as const) {
    const res = await app.request(`/api/projects/${projectId}/steps/${step}`, { method: "POST", headers: auth(token) })
    expect(res.status).toBe(200)
    await res.text()
  }
})

afterAll(async () => {
  await getDb().delete(users).where(inArray(users.id, [userId])) // 项目/文件/资料库随 user 级联删
  await closeDb()
})

describe("POST /:id/refresh-credentials-appendix：outline 补章失败不阻断响应", () => {
  it("syncCredentialsOutline 抛错 → 仍 200 {html}，content 已更新；outline 未获得 sys-creds（证明确实走了会抛错的补章路径）", async () => {
    const res = await app.request(`/api/projects/${projectId}/refresh-credentials-appendix`, {
      method: "POST", headers: auth(token),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { html: string }
    expect(body.html).toContain("<h3>营业执照</h3>")

    const [contentRow] = await getDb()
      .select({ result: projectSteps.result })
      .from(projectSteps)
      .where(and(eq(projectSteps.projectId, projectId), eq(projectSteps.step, "content"), eq(projectSteps.status, "done")))
    expect((contentRow!.result as Record<string, unknown>)["sys-creds"]).toBe(body.html) // 正文更新已落库

    const [outlineRow] = await getDb()
      .select({ result: projectSteps.result })
      .from(projectSteps)
      .where(and(eq(projectSteps.projectId, projectId), eq(projectSteps.step, "outline"), eq(projectSteps.status, "done")))
    const chapters = (outlineRow!.result as { chapters: { id: string }[] }).chapters
    expect(chapters.some((ch) => ch.id === "sys-creds")).toBe(false) // 补章确实没跑成（mock 生效的证据）
  })
})
