import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq } from "drizzle-orm"
import { getDb, closeDb } from "../src/db/client"
import { users, bidProjects } from "../src/db/schema"
import { markExportDirty, clearExportDirty, shouldChargeExport } from "../src/services/export-dirty"
import { loginWithPhone } from "../src/services/auth"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS)

/* 导出计费口径（2026-07-31 产品决定）：章节修改不收费，但**内容改过之后**的重新导出要收费。
   此前是「首次收费、之后一律免费」，于是改完正文再导出拿新文件不花钱；
   现在改成按脏标记判定——没改动就重复下载同一份仍然免费，避免手滑重点一下多扣 20 分。 */

let userId = ""
let projectId = ""

beforeAll(async () => {
  const r = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  userId = r.user.id
  const [p] = await getDb().insert(bidProjects)
    .values({ userId, threadId: `proj-${crypto.randomUUID()}` }).returning()
  projectId = p!.id
})

afterAll(async () => {
  await getDb().delete(users).where(eq(users.id, userId))
  await closeDb()
})

describe("导出脏标记", () => {
  it("新项目默认脏 —— 从未导出过，首次导出照收", async () => {
    expect(await shouldChargeExport(projectId)).toBe(true)
  })

  it("成功导出后置净 —— 没改动就重复下载不再收费", async () => {
    await clearExportDirty(projectId, new Date())
    expect(await shouldChargeExport(projectId)).toBe(false)
  })

  it("改过正文/提纲后重新变脏 —— 内容变了要收费", async () => {
    await clearExportDirty(projectId, new Date())
    await markExportDirty(projectId)
    expect(await shouldChargeExport(projectId)).toBe(true)
  })

  it("重复置脏幂等，不会把已收费的状态搞乱", async () => {
    await markExportDirty(projectId)
    await markExportDirty(projectId)
    expect(await shouldChargeExport(projectId)).toBe(true)
    await clearExportDirty(projectId, new Date())
    await clearExportDirty(projectId, new Date())
    expect(await shouldChargeExport(projectId)).toBe(false)
  })

  it("PATCH 提纲/正文会置脏，PATCH 述标 deck 不会 —— deck 改动不影响标书产物", async () => {
    // 这条锁住的是「哪些编辑该让导出重新收费」的口径，而不只是标记本身能读能写
    const { projectRoutes } = await import("../src/routes/projects")
    const { Hono } = await import("hono")
    const app = new Hono()
    app.route("/api/projects", projectRoutes({}))
    const r = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
    const [p2] = await getDb().insert(bidProjects)
      .values({ userId: r.user.id, threadId: `proj-${crypto.randomUUID()}` }).returning()
    const { projectSteps } = await import("../src/db/schema")
    await getDb().insert(projectSteps).values([
      { projectId: p2!.id, step: "outline", status: "done", result: { chapters: [] } },
      { projectId: p2!.id, step: "present", status: "done", result: { slides: [], qa: [] } },
    ])
    const patch = (step: string, result: unknown) =>
      app.request(`/api/projects/${p2!.id}/steps/${step}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${r.token}`, "content-type": "application/json" },
        body: JSON.stringify({ result }),
      })

    await clearExportDirty(p2!.id, new Date())
    const deck = {
      title: "述标", duration: 15, template: "blue", qa: [],
      slides: [{ id: "s1", title: "页", kind: "content", bullets: ["要点"] }],
    }
    expect((await patch("present", deck)).status).toBe(200)
    expect(await shouldChargeExport(p2!.id)).toBe(false)   // 述标编辑不影响标书导出

    // 必须提交与库中不同的内容：原样回写现在（正确地）不置脏，见下面「内容没变的保存不置脏」
    const changed = { chapters: [{ id: "b1", no: "第一章", title: "投标函", group: "business", items: [] }] }
    expect((await patch("outline", changed)).status).toBe(200)
    expect(await shouldChargeExport(p2!.id)).toBe(true)    // 改提纲 → 重新收费

    await getDb().delete(users).where(eq(users.id, r.user.id))
  })

  it("导出期间改的内容不被收尾抹平 —— 交付的文件不含它，下次导出就该收费", async () => {
    // 导出动辄数十秒到数分钟，期间 PATCH/改写不受 run 互斥保护。无条件清净会让这次改动
    // 既没进交付文件、又白白免掉下一次导出的费用。
    const runStartedAt = new Date()
    await markExportDirty(projectId)                     // 改动发生在 run 起步之后
    await clearExportDirty(projectId, runStartedAt)
    expect(await shouldChargeExport(projectId)).toBe(true)

    // 反面：run 起步之后没人改过 → 正常清净
    await clearExportDirty(projectId, new Date(Date.now() + 1000))
    expect(await shouldChargeExport(projectId)).toBe(false)
  })

  it("内容没变的保存不置脏 —— 一次误触不该值 20 积分", async () => {
    const { projectRoutes } = await import("../src/routes/projects")
    const { Hono } = await import("hono")
    const { projectSteps } = await import("../src/db/schema")
    const app = new Hono()
    app.route("/api/projects", projectRoutes({}))
    const r = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
    const [p3] = await getDb().insert(bidProjects)
      .values({ userId: r.user.id, threadId: `proj-${crypto.randomUUID()}` }).returning()
    const body = { "c1": "<p>原文</p>" }
    await getDb().insert(projectSteps)
      .values({ projectId: p3!.id, step: "content", status: "done", result: body })
    const patch = (result: unknown) =>
      app.request(`/api/projects/${p3!.id}/steps/content`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${r.token}`, "content-type": "application/json" },
        body: JSON.stringify({ result }),
      })

    await clearExportDirty(p3!.id, new Date(Date.now() + 1000))
    expect((await patch(body)).status).toBe(200)          // 原样回写
    expect(await shouldChargeExport(p3!.id)).toBe(false)  // 内容没变 → 不该收费

    expect((await patch({ "c1": "<p>改过了</p>" })).status).toBe(200)
    expect(await shouldChargeExport(p3!.id)).toBe(true)   // 真改了 → 收费

    await getDb().delete(users).where(eq(users.id, r.user.id))
  })

  it("项目不存在时按收费处理 —— 宁可收费也不能静默免单", async () => {
    // 查不到就当脏：漏收一次是钱的问题，误判免费则是账目对不上的问题
    expect(await shouldChargeExport(crypto.randomUUID())).toBe(true)
  })
})
