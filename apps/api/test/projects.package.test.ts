import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import { Hono } from "hono"
import { projectRoutes, type ProjectDeps } from "../src/routes/projects"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, bidProjects, projectFiles, projectSteps } from "../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB

// spec324：选包 PATCH /:id/package（设置/清除/属主隔离）+ run_input 按包下发（read 步不含，
// outline 及之后含）+ 克隆项目 POST /:id/clone（同文件/不同 thread，不带 selectedPackage）。

let tokenA = ""
let userA = ""
let tokenB = ""
let userB = ""
let keyA = ""

// 各步 agent result（snake 原样）：只需 read/outline 两步跑通即可验证 package 何时下发。
const STEP_RESULTS: Record<string, unknown> = {
  read: { categories: [], doc_sections: [] },
  outline: { chapters: [{ id: "ch-1", chapter_title: "技术方案", clause_ids: [] }] },
}
let runStep = ""
let lastRunInput: Record<string, unknown> = {}

const mockDeps: Partial<ProjectDeps> = {
  preDeduct: async () => ({ ok: true, holdId: "hold-x", hold: 10 }),
  settle: async (_ref, _holdId, actualCost) => actualCost,
  settleContent: async (_ref, _holdId, heldAmount) => heldAmount,
  settleFailed: async () => {},
  createRun: async (opts) => {
    const input = opts.input as { step: string; run_input: Record<string, unknown> }
    runStep = input.step
    lastRunInput = input.run_input
    return { run_id: crypto.randomUUID() }
  },
  relayStream: async function* () {
    yield "data: 进度\n\n"
  },
  getRun: async () => ({ status: "succeeded", result: STEP_RESULTS[runStep] }),
}

const app = new Hono()
app.route("/api/projects", projectRoutes(mockDeps))

beforeAll(async () => {
  const a = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  tokenA = a.token
  userA = a.user.id
  const b = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  tokenB = b.token
  userB = b.user.id

  keyA = `uploads/${userA}/${crypto.randomUUID()}/招标文件.pdf`
  await getDb()
    .insert(projectFiles)
    .values({ userId: userA, bucket: "bidsaas", key: keyA, filename: "招标文件.pdf", contentType: "application/pdf", size: 1, status: "uploaded" })
})

afterAll(async () => {
  await getDb().delete(users).where(inArray(users.id, [userA, userB])) // 项目/文件随 user 级联删
  await closeDb()
})

const auth = (token: string) => ({ Authorization: `Bearer ${token}`, "content-type": "application/json" })

const createProject = async (token: string, fileKey: string) => {
  const res = await app.request("/api/projects", { method: "POST", headers: auth(token), body: JSON.stringify({ fileKey }) })
  expect(res.status).toBe(200)
  return (await res.json()) as { id: string; threadId: string }
}

const patchPackage = (id: string, body: unknown, token: string) =>
  app.request(`/api/projects/${id}/package`, { method: "PATCH", headers: auth(token), body: JSON.stringify(body) })

describe("PATCH /api/projects/:id/package（spec324）", () => {
  it("设置：200 返回 selectedPackage，GET /:id 回读一致", async () => {
    const { id } = await createProject(tokenA, keyA)
    const res = await patchPackage(id, { id: "p1", name: "包1-实网攻防" }, tokenA)
    expect(res.status).toBe(200)
    expect((await res.json()) as { ok: boolean; selectedPackage: unknown }).toEqual({ ok: true, selectedPackage: { id: "p1", name: "包1-实网攻防" } })

    const detail = await app.request(`/api/projects/${id}`, { headers: auth(tokenA) })
    const body = (await detail.json()) as { project: { selectedPackage: unknown } }
    expect(body.project.selectedPackage).toEqual({ id: "p1", name: "包1-实网攻防" })
  })

  it("清除：body 裸 null → selectedPackage 变 null", async () => {
    const { id } = await createProject(tokenA, keyA)
    await patchPackage(id, { id: "p1", name: "包1" }, tokenA)
    const res = await patchPackage(id, null, tokenA)
    expect(res.status).toBe(200)
    expect((await res.json()) as { ok: boolean; selectedPackage: unknown }).toEqual({ ok: true, selectedPackage: null })

    const [row] = await getDb().select().from(bidProjects).where(eq(bidProjects.id, id))
    expect(row?.selectedPackage).toBeNull()
  })

  it("属主隔离：他人项目 → 404，不改动原值", async () => {
    const { id } = await createProject(tokenA, keyA)
    await patchPackage(id, { id: "p1", name: "包1" }, tokenA)
    const res = await patchPackage(id, { id: "p2", name: "包2" }, tokenB)
    expect(res.status).toBe(404)
    const [row] = await getDb().select().from(bidProjects).where(eq(bidProjects.id, id))
    expect(row?.selectedPackage).toEqual({ id: "p1", name: "包1" })
  })

  it("包件锁：提纲已开跑（存在 outline 步）→ 换包 409 package_locked，不改原值", async () => {
    const { id } = await createProject(tokenA, keyA)
    await patchPackage(id, { id: "p1", name: "包1" }, tokenA)
    // 模拟提纲已开跑：插一条 outline 步行
    await getDb().insert(projectSteps).values({ projectId: id, step: "outline", status: "running" } as any)
    const res = await patchPackage(id, { id: "p2", name: "包2" }, tokenA)
    expect(res.status).toBe(409)
    expect((await res.json()) as { error: string }).toEqual({ error: "package_locked" })
    const [row] = await getDb().select().from(bidProjects).where(eq(bidProjects.id, id))
    expect(row?.selectedPackage).toEqual({ id: "p1", name: "包1" }) // 原值不变
  })

  it("坏形状（缺 name/空字符串/非对象非 null）→ 400 invalid_input", async () => {
    const { id } = await createProject(tokenA, keyA)
    for (const body of [{ id: "p1" }, { id: "", name: "x" }, { id: "p1", name: "" }, "nope", 1]) {
      const res = await patchPackage(id, body, tokenA)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe("invalid_input")
    }
  })

  it("非 uuid 项目 → 404", async () => {
    const res = await patchPackage("not-a-uuid", { id: "p1", name: "包1" }, tokenA)
    expect(res.status).toBe(404)
  })
})

describe("run_input.package 下发（spec324）：read 步不含，outline 及之后步含", () => {
  it("已选包：read 步 run_input 无 package；outline 步 run_input 带 package（rag 不丢）", async () => {
    const { id } = await createProject(tokenA, keyA)
    await patchPackage(id, { id: "p1", name: "包1-实网攻防" }, tokenA)

    const readRes = await app.request(`/api/projects/${id}/steps/read`, { method: "POST", headers: auth(tokenA) })
    expect(readRes.status).toBe(200)
    await readRes.text()
    expect(lastRunInput.package).toBeUndefined() // read 面向全文，不分包
    expect(lastRunInput.rag).toEqual({ enabled: true, top_k: 3 }) // rag 不被 package 挤掉

    const outlineRes = await app.request(`/api/projects/${id}/steps/outline`, { method: "POST", headers: auth(tokenA) })
    expect(outlineRes.status).toBe(200)
    await outlineRes.text()
    expect(lastRunInput.package).toEqual({ id: "p1", name: "包1-实网攻防" })
    expect(lastRunInput.rag).toEqual({ enabled: true, top_k: 3 })
  })

  it("未选包：outline 步 run_input 不含 package（今天行为不变）", async () => {
    const { id } = await createProject(tokenA, keyA)
    const readRes = await app.request(`/api/projects/${id}/steps/read`, { method: "POST", headers: auth(tokenA) })
    await readRes.text()
    const outlineRes = await app.request(`/api/projects/${id}/steps/outline`, { method: "POST", headers: auth(tokenA) })
    await outlineRes.text()
    expect(outlineRes.status).toBe(200)
    expect(lastRunInput.package).toBeUndefined()
  })
})

describe("POST /api/projects/:id/clone（spec324）", () => {
  it("克隆：新项目/新 thread_id，同 tenderFileKey(s)，name 缺省加「（再投）」后缀，不带 selectedPackage", async () => {
    const { id, threadId } = await createProject(tokenA, keyA)
    await patchPackage(id, { id: "p1", name: "包1" }, tokenA)

    const res = await app.request(`/api/projects/${id}/clone`, { method: "POST", headers: auth(tokenA) })
    expect(res.status).toBe(200)
    const clone = (await res.json()) as { id: string; threadId: string }
    expect(clone.id).not.toBe(id)
    expect(clone.threadId).not.toBe(threadId)
    expect(clone.threadId.startsWith("proj-")).toBe(true)

    const [row] = await getDb().select().from(bidProjects).where(eq(bidProjects.id, clone.id))
    expect(row?.tenderFileKey).toBe(keyA)
    expect(row?.tenderFileKeys).toEqual([keyA])
    expect(row?.name).toBe("招标文件.pdf（再投）")
    expect(row?.selectedPackage).toBeNull() // 不复制选包
    expect(row?.status).toBe("draft") // 全新起步
    expect(row?.currentStep).toBe("read")
  })

  it("body 传 name 时覆盖默认后缀名", async () => {
    const { id } = await createProject(tokenA, keyA)
    const res = await app.request(`/api/projects/${id}/clone`, {
      method: "POST",
      headers: auth(tokenA),
      body: JSON.stringify({ name: "南瑞标-包2" }),
    })
    expect(res.status).toBe(200)
    const clone = (await res.json()) as { id: string }
    const [row] = await getDb().select().from(bidProjects).where(eq(bidProjects.id, clone.id))
    expect(row?.name).toBe("南瑞标-包2")
  })

  it("属主隔离：他人项目 → 404，不留孤儿项目行", async () => {
    const { id } = await createProject(tokenA, keyA)
    const before = (await getDb().select().from(bidProjects).where(eq(bidProjects.userId, userB))).length
    const res = await app.request(`/api/projects/${id}/clone`, { method: "POST", headers: auth(tokenB) })
    expect(res.status).toBe(404)
    const after = (await getDb().select().from(bidProjects).where(eq(bidProjects.userId, userB))).length
    expect(after).toBe(before)
  })

  it("非 uuid 项目 → 404", async () => {
    const res = await app.request("/api/projects/not-a-uuid/clone", { method: "POST", headers: auth(tokenA) })
    expect(res.status).toBe(404)
  })
})
