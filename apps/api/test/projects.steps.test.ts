import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { projectRoutes, type ProjectDeps } from "../src/routes/projects"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, bidProjects, projectSteps } from "../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连真库

let token = ""
let userId = ""
let capturedRunId = ""
const captured: {
  preDeductSteps: string[]
  createRunOpts?: Parameters<ProjectDeps["createRun"]>[0]
  settleArgs?: { runId: string; hold: number }
} = { preDeductSteps: [] }

const mockDeps: Partial<ProjectDeps> = {
  preDeduct: async (step: string) => {
    captured.preDeductSteps.push(step)
    return { ok: true, hold: 10 }
  },
  settle: async (runId: string, hold: number) => {
    captured.settleArgs = { runId, hold }
    return hold
  },
  createRun: async (opts) => {
    captured.createRunOpts = opts
    capturedRunId = crypto.randomUUID()
    return { run_id: capturedRunId }
  },
  relayStream: async function* () {
    yield "data: 进度\n\n"
  },
  getRun: async () => ({
    status: "succeeded",
    result: { categories: [{ key: "qualification", title: "资格", items: [{ clause_ids: ["sec-1-c1"], is_new: false }] }] },
  }),
}

const app = new Hono()
app.route("/api/projects", projectRoutes(mockDeps))

beforeAll(async () => {
  const r = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  token = r.token
  userId = r.user.id
})

afterAll(async () => {
  await getDb().delete(users).where(eq(users.id, userId)) // 项目/步随 user 级联删
  await closeDb()
})

const auth = () => ({ Authorization: `Bearer ${token}`, "content-type": "application/json" })

describe("/api/projects 按步编排", () => {
  let projectId = ""

  it("建项目返回 threadId", async () => {
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ fileKey: "uploads/x/tender.pdf" }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string; threadId: string }
    expect(body.threadId.startsWith("proj-")).toBe(true)
    projectId = body.id
  })

  it("draft 项目跳步（outline）→ 409 且不预扣不建 run", async () => {
    const before = captured.preDeductSteps.length
    const res = await app.request(`/api/projects/${projectId}/steps/outline`, { method: "POST", headers: auth() })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe("out_of_order")
    expect(captured.preDeductSteps.length).toBe(before) // 未调 preDeduct
  })

  it("read 步：预扣→建 run(带 threadId)→SSE 中继→存结果(snake_case)→currentStep→outline；SSE result 已 camelCase", async () => {
    const res = await app.request(`/api/projects/${projectId}/steps/read`, { method: "POST", headers: auth() })
    expect(res.status).toBe(200)
    const sse = await res.text()

    expect(captured.preDeductSteps).toContain("read")
    expect(captured.createRunOpts?.agentType).toBe("bidding_agent")
    expect((captured.createRunOpts?.input as { step: string }).step).toBe("read")
    expect((captured.createRunOpts?.input as { text: string }).text).toContain("key=uploads/x/tender.pdf")
    expect(sse).toContain("data: 进度")
    expect(sse).toContain("event: step.done")
    expect(sse).toContain("clauseIds") // SSE 的 result 已转 camelCase
    expect(captured.settleArgs).toEqual({ runId: capturedRunId, hold: 10 })

    // 落库为 snake_case 原样；currentStep 推进
    const [s] = await getDb().select().from(projectSteps).where(eq(projectSteps.runId, capturedRunId))
    if (!s) throw new Error("project_step 未落库")
    expect(s.status).toBe("done")
    expect(JSON.stringify(s.result)).toContain("clause_ids")
    const [p] = await getDb().select().from(bidProjects).where(eq(bidProjects.id, projectId))
    expect(p?.currentStep).toBe("outline")
    expect(p?.status).toBe("running")
  })

  it("GET /:id 返回项目 + 各步 result（camelCase）", async () => {
    const res = await app.request(`/api/projects/${projectId}`, { headers: auth() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { steps: Array<{ result: unknown }> }
    expect(JSON.stringify(body.steps[0]?.result)).toContain("clauseIds")
  })

  it("再推 read（已不是当前步）→ 409", async () => {
    const res = await app.request(`/api/projects/${projectId}/steps/read`, { method: "POST", headers: auth() })
    expect(res.status).toBe(409)
  })

  it("未知步骤 → 400；他人项目 → 404", async () => {
    const bad = await app.request(`/api/projects/${projectId}/steps/nope`, { method: "POST", headers: auth() })
    expect(bad.status).toBe(400)
    const other = await app.request(`/api/projects/${crypto.randomUUID()}/steps/read`, {
      method: "POST",
      headers: auth(),
    })
    expect(other.status).toBe(404)
  })
})
