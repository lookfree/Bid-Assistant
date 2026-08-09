import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { inArray } from "drizzle-orm"
import { Hono } from "hono"
import { projectRoutes, type ProjectDeps } from "../src/routes/projects"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, projectFiles } from "../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB

// 终审 C1：GET /:id/export-preview 新增 volumes（各册最近一次成功导出时刻）+ content_changed_at，
// 供 web 下载区判断某册是否在内容最近一次变更之后重新导出过（过期则禁用该册按钮）。
// 核心回归：agent 侧 artifacts 通道跨 run 合并（present 的 pptx 与 export 的 docx 并存不覆盖）——
// 先导全量、改稿、再单独导技术册，技术册那行 result 里全量的 docx 键依然原样健在；若 App 只按
// 「result 是否含某册 docx 键」找「最近一行」，会把技术册那次的时间戳错记成全量的导出时刻，
// 过期判定形同虚设（正是这条要修的 bug）。mock 的 createRun/getRun 在这里真实模拟这一合并语义
// （而非像 export-scope.test.ts 那样对每个 scope 回同一份固定结果），才能立住这条回归断言。

let token = ""
let userId = ""
let key = ""
let projectId = ""

const STEP_RESULTS: Record<string, unknown> = {
  read: { categories: [], doc_sections: [] },
  outline: { chapters: [{ id: "ch-1", chapter_title: "技术方案", clause_ids: [] }] },
  content: { "ch-1": "<p>正文</p>" },
  review: { issues: [] },
  present: { title: "述标", duration: 15, template: "gov", slides: [{ id: "s-1", title: "封面" }], qa: [] },
}
let runStep = ""
// export 步的合并态 artifacts：模拟 agent 侧跨 run 合并 reducer——不同 scope 的键各自累加，
// 已有键不被别的 scope 那次运行覆盖（见 services/agent 侧 nodes/export.py 的文档串）。
let exportArtifacts: Record<string, unknown> = {}

const mockDeps: Partial<ProjectDeps> = {
  resolveStepHoldAmount: async (step: string) => (step === "content" ? 260 : undefined),
  preDeduct: async () => ({ ok: true, holdId: "hold-x", hold: 10 }),
  settle: async (_ref, _holdId, actualCost) => actualCost,
  settleContent: async (_ref, _holdId, heldAmount) => heldAmount,
  settleFailed: async () => {},
  createRun: async (opts) => {
    const input = opts.input as { step: string; run_input: Record<string, unknown> }
    runStep = input.step
    if (input.step === "export") {
      const scope = (input.run_input.export_scope as string) || "full"
      const sfx = scope === "tech" ? "_tech" : scope === "business" ? "_biz" : ""
      exportArtifacts = {
        ...exportArtifacts, // 累加，不清空别的 scope 已产出的键——与真实 merge reducer 同语义
        [`docx${sfx}`]: `artifacts/x/bid${sfx}.docx`,
        [`exported_at${sfx}`]: new Date().toISOString(),
      }
    }
    return { run_id: crypto.randomUUID() }
  },
  relayStream: async function* () {
    yield "data: 进度\n\n"
  },
  getRun: async () => ({ status: "succeeded", result: runStep === "export" ? exportArtifacts : STEP_RESULTS[runStep] }),
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

  key = `uploads/${userId}/${crypto.randomUUID()}/招标文件.pdf`
  await getDb()
    .insert(projectFiles)
    .values({ userId, bucket: "bidsaas", key, filename: "招标文件.pdf", contentType: "application/pdf", size: 1, status: "uploaded" })

  const created = await app.request("/api/projects", { method: "POST", headers: auth(token), body: JSON.stringify({ fileKey: key }) })
  expect(created.status).toBe(200)
  const { id } = (await created.json()) as { id: string }
  projectId = id

  // 走完 read→outline→content→review→present，把 currentStep 推到 export 前置条件满足处；
  // content 步落库后 markExportDirty 生效，contentChangedAt 首次被置（供下方"改稿"断言的基线）。
  for (const step of ["read", "outline", "content", "review", "present"] as const) {
    const res = await app.request(`/api/projects/${projectId}/steps/${step}`, { method: "POST", headers: auth(token) })
    expect(res.status).toBe(200)
    await res.text()
  }
})

afterAll(async () => {
  await getDb().delete(users).where(inArray(users.id, [userId])) // 项目/文件随 user 级联删
  await closeDb()
})

const runExport = async (body: Record<string, unknown>) => {
  const res = await app.request(`/api/projects/${projectId}/steps/export`, { method: "POST", headers: auth(token), body: JSON.stringify(body) })
  expect(res.status).toBe(200)
  await res.text()
}

const preview = async () => {
  const res = await app.request(`/api/projects/${projectId}/export-preview`, { headers: auth(token) })
  expect(res.status).toBe(200)
  return (await res.json()) as {
    volumes: { full: string | null; tech: string | null; biz: string | null }
    content_changed_at: string | null
  }
}

describe("GET /:id/export-preview volumes/content_changed_at（终审 C1）", () => {
  it("从未导出过：三册 exportedAt 均为 null", async () => {
    const body = await preview()
    expect(body.volumes).toEqual({ full: null, tech: null, biz: null })
    expect(typeof body.content_changed_at).toBe("string") // setup 阶段 content 步已落库过一次，非 null
  })

  it("全量导出一次后：volumes.full 变为 ISO 时间串，tech/biz 仍为 null", async () => {
    await runExport({})
    const body = await preview()
    expect(body.volumes.tech).toBeNull()
    expect(body.volumes.biz).toBeNull()
    expect(typeof body.volumes.full).toBe("string")
    expect(Number.isNaN(new Date(body.volumes.full!).getTime())).toBe(false)
  })

  it("改稿后只导技术册：技术册最新未过期，全量册停在改稿前的旧时刻（过期）——回归本 bug", async () => {
    const before = await preview()
    const fullAtBeforeEdit = before.volumes.full!

    // 模拟用户改了正文（与 STEP_RESULTS.content 不同的 HTML，触发 markExportDirty）
    const patched = await app.request(`/api/projects/${projectId}/steps/content`, {
      method: "PATCH", headers: auth(token),
      body: JSON.stringify({ result: { "ch-1": "<p>修改后的正文</p>" } }),
    })
    expect(patched.status).toBe(200)

    await runExport({ export_scope: "tech" })
    const after = await preview()

    // content_changed_at 已推进到刚才那次改稿之后
    expect(after.content_changed_at).not.toBeNull()
    expect(new Date(after.content_changed_at!).getTime()).toBeGreaterThan(new Date(before.content_changed_at!).getTime())

    // 技术册：本次真渲染，晚于改稿时刻 → 未过期
    expect(new Date(after.volumes.tech!).getTime()).toBeGreaterThanOrEqual(new Date(after.content_changed_at!).getTime())

    // 全量册：本次 export 请求根本没有重渲全量（scope=tech），volumes.full 必须原样停在
    // 改稿前那次全量导出的时刻——早于改稿时刻，即"过期"。这正是本要修的 bug：若实现退化成
    // "result 是否含 docx 键就用这一行的 createdAt"，这里会被技术册那次运行的新时间戳带偏，
    // 错误地显示为"未过期"。
    expect(after.volumes.full).toBe(fullAtBeforeEdit)
    expect(new Date(after.volumes.full!).getTime()).toBeLessThan(new Date(after.content_changed_at!).getTime())
  })

  it("他人项目 → 404", async () => {
    const b = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => "ok" as const)
    const res = await app.request(`/api/projects/${projectId}/export-preview`, { headers: auth(b.token) })
    expect(res.status).toBe(404)
    await getDb().delete(users).where(inArray(users.id, [b.user.id]))
  })
})
