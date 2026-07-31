import { describe, it, expect, afterAll, setDefaultTimeout } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import { Hono } from "hono"
import { adminRoutes } from "../src/routes/admin"
import { getDb, closeDb } from "../src/db/client"
import { users, adminUsers, bidProjects, bidCategoryCorrections, type BidCategoryValue } from "../src/db/schema"
import { makeUserWithNickname, makeAdminSession, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB

// spec334 分类纠偏样本的运营视图：判定质量的唯一反馈回路，只读。

const app = new Hono()
app.route("/admin-api", adminRoutes())
const madeUsers: string[] = []
const madeAdmins: string[] = []
const madeProjects: string[] = []

afterAll(async () => {
  await getDb().delete(bidCategoryCorrections).where(inArray(bidCategoryCorrections.projectId, madeProjects))
  for (const id of madeUsers) await getDb().delete(users).where(eq(users.id, id))
  for (const id of madeAdmins) await getDb().delete(adminUsers).where(eq(adminUsers.id, id))
  await closeDb()
})

async function seedCorrection(detected: BidCategoryValue[], confirmed: BidCategoryValue[]) {
  const userId = await makeUserWithNickname((id) => madeUsers.push(id), "分类纠偏")
  const [p] = await getDb()
    .insert(bidProjects)
    .values({ userId, threadId: `proj-${crypto.randomUUID()}`, name: "某平台采购" })
    .returning()
  madeProjects.push(p!.id)
  await getDb()
    .insert(bidCategoryCorrections)
    .values({ projectId: p!.id, detected, confirmed, confidence: "medium" })
  return p!.id
}

describe("spec334 分类纠偏样本", () => {
  it("明细：回改判记录并带项目名（便于回溯是哪一本标）", async () => {
    const projectId = await seedCorrection(["goods"], ["services"])
    const { token } = await makeAdminSession("ops", (id) => madeAdmins.push(id))
    const res = await app.request("/admin-api/bid-categories/corrections", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: Array<{ projectId: string; detected: string[]; confirmed: string[]; projectName: string | null }> }
    const mine = body.items.find((i) => i.projectId === projectId)
    expect(mine?.detected).toEqual(["goods"])
    expect(mine?.confirmed).toEqual(["services"])
    expect(mine?.projectName).toBe("某平台采购")
  })

  it("聚合：按判错方向计数，只比主类别——次类别是补充，主类别错才把标书结构带偏", async () => {
    await seedCorrection(["engineering", "services"], ["services", "goods"])
    const { token } = await makeAdminSession("ops", (id) => madeAdmins.push(id))
    const res = await app.request("/admin-api/bid-categories/corrections/summary", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: Array<{ detected: string; confirmed: string; count: number }> }
    const row = body.items.find((i) => i.detected === "engineering" && i.confirmed === "services")
    expect(row?.count).toBeGreaterThanOrEqual(1)
  })

  it("未登录 → 401", async () => {
    expect((await app.request("/admin-api/bid-categories/corrections")).status).toBe(401)
  })
})
