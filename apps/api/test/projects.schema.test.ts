import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, bidProjects, projectSteps } from "../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB

let userId = ""

beforeAll(async () => {
  const r = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  userId = r.user.id
})

afterAll(async () => {
  await getDb().delete(users).where(eq(users.id, userId)) // bid_projects/project_steps 随 user 级联删
  await closeDb()
})

describe("bid_projects / project_steps", () => {
  it("建项目 + 加一步并查回，默认值正确", async () => {
    const threadId = `proj-${crypto.randomUUID()}`
    const [p] = await getDb()
      .insert(bidProjects)
      .values({ userId, threadId, tenderFileKey: "uploads/x/tender.pdf" })
      .returning()
    if (!p) throw new Error("bid_project 未插入")
    expect(p.status).toBe("draft")
    expect(p.currentStep).toBe("read")

    const [s] = await getDb()
      .insert(projectSteps)
      .values({ projectId: p.id, step: "read", runId: `run-${crypto.randomUUID()}`, status: "running" })
      .returning()
    if (!s) throw new Error("project_step 未插入")
    expect(s.costPoints).toBe(0)
    const rows = await getDb().select().from(projectSteps).where(eq(projectSteps.projectId, p.id))
    expect(rows.length).toBe(1)
  })

  it("thread_id 唯一，重复插入报错", async () => {
    const threadId = `proj-${crypto.randomUUID()}`
    await getDb().insert(bidProjects).values({ userId, threadId })
    let threw = false
    try {
      await getDb().insert(bidProjects).values({ userId, threadId })
    } catch {
      threw = true // 唯一约束冲突
    }
    expect(threw).toBe(true)
  })
})
