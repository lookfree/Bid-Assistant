import { describe, it, expect, afterAll, setDefaultTimeout } from "bun:test"
import { eq, desc } from "drizzle-orm"
import { writeAudit } from "../../src/services/audit"
import { getDb, closeDb } from "../../src/db/client"
import { adminAuditLogs } from "../../src/db/schema"
import { TEST_TIMEOUT_MS } from "../repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB（跑法：./test-on-mbp.sh test/services/audit.test.ts）

const operator = `auditor_${Date.now()}`

afterAll(async () => {
  await getDb().delete(adminAuditLogs).where(eq(adminAuditLogs.operator, operator))
  await closeDb()
})

describe("spec309 审计装置 writeAudit", () => {
  it("记录操作人/动作/对象 + 前后值", async () => {
    await writeAudit({ operator, action: "plan.update", target: "plan-123", before: { priceCents: 1000 }, after: { priceCents: 2000 } })
    const [row] = await getDb()
      .select()
      .from(adminAuditLogs)
      .where(eq(adminAuditLogs.operator, operator))
      .orderBy(desc(adminAuditLogs.createdAt))
      .limit(1)
    expect(row?.action).toBe("plan.update")
    expect(row?.target).toBe("plan-123")
    expect((row?.before as { priceCents: number }).priceCents).toBe(1000)
    expect((row?.after as { priceCents: number }).priceCents).toBe(2000)
  })

  it("允许 before/after 缺省", async () => {
    await writeAudit({ operator, action: "user.ban", target: "user-9" })
    const rows = await getDb().select().from(adminAuditLogs).where(eq(adminAuditLogs.operator, operator))
    expect(rows.length).toBeGreaterThanOrEqual(2)
  })
})
