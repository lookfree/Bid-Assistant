import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, agentRuns } from "../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB

let userId = ""

beforeAll(async () => {
  const r = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  userId = r.user.id
})

afterAll(async () => {
  await getDb().delete(users).where(eq(users.id, userId)) // agent_runs 随 user 级联删
  await closeDb()
})

describe("agent_runs 桥接表", () => {
  it("插入一行并查回，agentType/runId 正确", async () => {
    const runId = `run-${crypto.randomUUID()}`
    await getDb()
      .insert(agentRuns)
      .values({ userId, agentType: "bidding_agent", runId, threadId: `proj-${crypto.randomUUID()}` })
    const [row] = await getDb().select().from(agentRuns).where(eq(agentRuns.runId, runId))
    expect(row.agentType).toBe("bidding_agent")
    expect(row.status).toBe("running")
    expect(row.costPoints).toBe(0)
  })

  it("runId 唯一，重复插入报错", async () => {
    const runId = `run-${crypto.randomUUID()}`
    const threadId = `proj-${crypto.randomUUID()}`
    await getDb().insert(agentRuns).values({ userId, agentType: "bidding_agent", runId, threadId })
    let threw = false
    try {
      await getDb().insert(agentRuns).values({ userId, agentType: "bidding_agent", runId, threadId })
    } catch {
      threw = true // 唯一约束冲突
    }
    expect(threw).toBe(true)
  })
})
