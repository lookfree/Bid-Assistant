import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { readRoutes, type ReadDeps } from "../src/routes/read"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, agentRuns } from "../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连真库落 agent_runs

let token = ""
let userId = ""
let capturedRunId = ""
const captured: { preDeductStep?: string; createRunOpts?: Parameters<ReadDeps["createRun"]>[0]; settleArgs?: { runId: string; hold: number } } = {}

const mockDeps: Partial<ReadDeps> = {
  preDeduct: async (step: string) => {
    captured.preDeductStep = step
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
    status: "done",
    result: { categories: [{ key: "qualification", title: "资格要求", items: [] }], risk_summary: ["ISO27001 缺失即废标"] },
  }),
}

const app = new Hono()
app.route("/api/read", readRoutes(mockDeps))

beforeAll(async () => {
  const r = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  token = r.token
  userId = r.user.id
})

afterAll(async () => {
  await getDb().delete(users).where(eq(users.id, userId)) // agent_runs 随 user 级联删
  await closeDb()
})

describe("/api/read 编排", () => {
  it("预扣→建run→SSE中继→存结果→settle", async () => {
    const res = await app.request("/api/read", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ fileKey: "uploads/x/tender.pdf" }),
    })
    expect(res.status).toBe(200)
    const sse = await res.text()

    // 编排次序 + 契约
    expect(captured.preDeductStep).toBe("read")
    expect(captured.createRunOpts?.agentType).toBe("bidding_agent")
    expect(captured.createRunOpts?.input).toEqual({
      text: "请对招标文件读标，key=uploads/x/tender.pdf",
      file_key: "uploads/x/tender.pdf",
      step: "read",
    })
    expect(sse).toContain("data: 进度") // 中继了 agent 进度分片
    expect(sse).toContain("event: done") // 末尾 done
    expect(captured.settleArgs).toEqual({ runId: capturedRunId, hold: 10 })

    // 结果落库
    const [row] = await getDb().select().from(agentRuns).where(eq(agentRuns.runId, capturedRunId))
    if (!row) throw new Error("agent_run 未落库")
    expect(row.status).toBe("done")
    expect(row.costPoints).toBe(10)
    expect((row.result as { risk_summary: string[] }).risk_summary).toEqual(["ISO27001 缺失即废标"])
  })

  it("未知 run → 404", async () => {
    const res = await app.request(`/api/read/runs/${crypto.randomUUID()}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(404)
  })
})
