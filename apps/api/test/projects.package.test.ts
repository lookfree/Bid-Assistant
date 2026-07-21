import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { eq, and, inArray } from "drizzle-orm"
import { Hono } from "hono"
import { projectRoutes, type ProjectDeps } from "../src/routes/projects"
import { loginWithPhone } from "../src/services/auth"
import { getDb, closeDb } from "../src/db/client"
import { users, bidProjects, projectFiles, projectSteps } from "../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "./repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连远程 DB

// spec324：选包 PATCH /:id/package（设置/清除/属主隔离/改名带包名）+ run_input 按包下发（read 步不含，
// outline 及之后含）+ 克隆项目 POST /:id/clone（同文件/不同 thread；建项即选包）+ 多包硬门禁
// （未选包不允许生成大纲 400 package_required）+ 包占用（已生成的包全链路 409 package_taken）。

let tokenA = ""
let userA = ""
let tokenB = ""
let userB = ""

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
  getAgentModel: async () => ({
    provider: "deepseek", model: "deepseek-chat", fallbacks: "",
    params: { temperature: 0.7, max_tokens: 8192, top_p: 1 },
    chain: [{ provider: "deepseek", model: "deepseek-chat" }],
  }),
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
})

afterAll(async () => {
  await getDb().delete(users).where(inArray(users.id, [userA, userB])) // 项目/文件随 user 级联删
  await closeDb()
})

const auth = (token: string) => ({ Authorization: `Bearer ${token}`, "content-type": "application/json" })

// 每次建项都用全新文件 key：包占用（takenPackageIds）按同 tenderFileKey 的兄弟项目计算，
// 共用一个 key 会让前面测试锁掉的包泄漏进后面的测试（同文件即同家族）；克隆出的项目才共享 key。
const createProject = async (token: string) => {
  const userId = token === tokenA ? userA : userB
  const key = `uploads/${userId}/${crypto.randomUUID()}/招标文件.pdf`
  await getDb()
    .insert(projectFiles)
    .values({ userId, bucket: "bidsaas", key, filename: "招标文件.pdf", contentType: "application/pdf", size: 1, status: "uploaded" })
  const res = await app.request("/api/projects", { method: "POST", headers: auth(token), body: JSON.stringify({ fileKey: key }) })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { id: string; threadId: string }
  return { ...body, key }
}

const patchPackage = (id: string, body: unknown, token: string) =>
  app.request(`/api/projects/${id}/package`, { method: "PATCH", headers: auth(token), body: JSON.stringify(body) })

describe("PATCH /api/projects/:id/package（spec324）", () => {
  it("设置：200 返回 selectedPackage，GET /:id 回读一致", async () => {
    const { id } = await createProject(tokenA)
    const res = await patchPackage(id, { id: "p1", name: "包1-实网攻防" }, tokenA)
    expect(res.status).toBe(200)
    expect((await res.json()) as { ok: boolean; selectedPackage: unknown }).toEqual({ ok: true, selectedPackage: { id: "p1", name: "包1-实网攻防" } })

    const detail = await app.request(`/api/projects/${id}`, { headers: auth(tokenA) })
    const body = (await detail.json()) as { project: { selectedPackage: unknown } }
    expect(body.project.selectedPackage).toEqual({ id: "p1", name: "包1-实网攻防" })
  })

  it("清除：body 裸 null → selectedPackage 变 null", async () => {
    const { id } = await createProject(tokenA)
    await patchPackage(id, { id: "p1", name: "包1" }, tokenA)
    const res = await patchPackage(id, null, tokenA)
    expect(res.status).toBe(200)
    expect((await res.json()) as { ok: boolean; selectedPackage: unknown }).toEqual({ ok: true, selectedPackage: null })

    const [row] = await getDb().select().from(bidProjects).where(eq(bidProjects.id, id))
    expect(row?.selectedPackage).toBeNull()
  })

  it("属主隔离：他人项目 → 404，不改动原值", async () => {
    const { id } = await createProject(tokenA)
    await patchPackage(id, { id: "p1", name: "包1" }, tokenA)
    const res = await patchPackage(id, { id: "p2", name: "包2" }, tokenB)
    expect(res.status).toBe(404)
    const [row] = await getDb().select().from(bidProjects).where(eq(bidProjects.id, id))
    expect(row?.selectedPackage).toEqual({ id: "p1", name: "包1" })
  })

  it("包件锁：提纲已开跑（存在 outline 步）→ 换包 409 package_locked，不改原值", async () => {
    const { id } = await createProject(tokenA)
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
    const { id } = await createProject(tokenA)
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
    const { id } = await createProject(tokenA)
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
    const { id } = await createProject(tokenA)
    const readRes = await app.request(`/api/projects/${id}/steps/read`, { method: "POST", headers: auth(tokenA) })
    await readRes.text()
    const outlineRes = await app.request(`/api/projects/${id}/steps/outline`, { method: "POST", headers: auth(tokenA) })
    await outlineRes.text()
    expect(outlineRes.status).toBe(200)
    expect(lastRunInput.package).toBeUndefined()
  })
})

describe("POST /api/projects/:id/clone（spec324）", () => {
  it("克隆：新项目/新 thread_id，同 tenderFileKey(s)；源已选包 → name 剥包名后缀取基名，不复制选包", async () => {
    const { id, threadId, key } = await createProject(tokenA)
    await patchPackage(id, { id: "p1", name: "包1" }, tokenA) // 源项目名变「招标文件.pdf·包1」

    const res = await app.request(`/api/projects/${id}/clone`, { method: "POST", headers: auth(tokenA) })
    expect(res.status).toBe(200)
    const clone = (await res.json()) as { id: string; threadId: string }
    expect(clone.id).not.toBe(id)
    expect(clone.threadId).not.toBe(threadId)
    expect(clone.threadId.startsWith("proj-")).toBe(true)

    const [row] = await getDb().select().from(bidProjects).where(eq(bidProjects.id, clone.id))
    expect(row?.tenderFileKey).toBe(key)
    expect(row?.tenderFileKeys).toEqual([key])
    expect(row?.name).toBe("招标文件.pdf") // 剥掉源的「·包1」；新项目选包时再拼自己的包名
    expect(row?.selectedPackage).toBeNull() // 不复制选包
    expect(row?.status).toBe("draft") // 全新起步
    expect(row?.currentStep).toBe("read")
  })

  it("源未选包 → name 保留「（再投）」区分", async () => {
    const { id } = await createProject(tokenA)
    const res = await app.request(`/api/projects/${id}/clone`, { method: "POST", headers: auth(tokenA) })
    expect(res.status).toBe(200)
    const clone = (await res.json()) as { id: string }
    const [row] = await getDb().select().from(bidProjects).where(eq(bidProjects.id, clone.id))
    expect(row?.name).toBe("招标文件.pdf（再投）")
  })

  it("建项即选包：body.package → 新项目带 selectedPackage，name=基名·包名", async () => {
    const { id } = await createProject(tokenA)
    await patchPackage(id, { id: "p1", name: "包1" }, tokenA)
    const res = await app.request(`/api/projects/${id}/clone`, {
      method: "POST", headers: auth(tokenA), body: JSON.stringify({ package: { id: "p2", name: "包2" } }),
    })
    expect(res.status).toBe(200)
    const clone = (await res.json()) as { id: string }
    const [row] = await getDb().select().from(bidProjects).where(eq(bidProjects.id, clone.id))
    expect(row?.selectedPackage).toEqual({ id: "p2", name: "包2" })
    expect(row?.name).toBe("招标文件.pdf·包2")
  })

  it("body 传 name 时覆盖默认后缀名", async () => {
    const { id } = await createProject(tokenA)
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
    const { id } = await createProject(tokenA)
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

describe("选包改名：项目名带包名（重选剥旧拼新，清包剥回基名）", () => {
  it("patch p1 → 「基名·包1」；重选 p2 → 「基名·包2」（不叠加）；清包 → 基名", async () => {
    const { id } = await createProject(tokenA)
    const nameOf = async () =>
      (await getDb().select().from(bidProjects).where(eq(bidProjects.id, id)))[0]?.name
    await patchPackage(id, { id: "p1", name: "包1" }, tokenA)
    expect(await nameOf()).toBe("招标文件.pdf·包1")
    await patchPackage(id, { id: "p2", name: "包2" }, tokenA)
    expect(await nameOf()).toBe("招标文件.pdf·包2")
    await patchPackage(id, null, tokenA)
    expect(await nameOf()).toBe("招标文件.pdf")
  })
})

/** 把项目的 read 步结果改造成多包形态（p1/p2/p3），模拟多包件招标读标完成后的状态。 */
async function makeMultiPackageRead(projectId: string) {
  await getDb()
    .update(projectSteps)
    .set({ result: { categories: [], packages: [
      { id: "p1", name: "包1" }, { id: "p2", name: "包2" }, { id: "p3", name: "包3" },
    ] } })
    .where(and(eq(projectSteps.projectId, projectId), eq(projectSteps.step, "read")))
}

describe("多包硬门禁 + 包占用（一包一份投标文件）", () => {
  it("未选包不允许生成大纲：400 package_required 不留占位行；选包后放行；已生成的包全链路不可再投", async () => {
    // A 项目：读标完成（多包 p1/p2/p3），未选包
    const { id: idA } = await createProject(tokenA)
    await (await app.request(`/api/projects/${idA}/steps/read`, { method: "POST", headers: auth(tokenA) })).text()
    await makeMultiPackageRead(idA)

    // 未选包 → 400 package_required，且不占步位（无 outline 行）不预扣
    const blocked = await app.request(`/api/projects/${idA}/steps/outline`, { method: "POST", headers: auth(tokenA) })
    expect(blocked.status).toBe(400)
    expect(((await blocked.json()) as { error: string }).error).toBe("package_required")
    const rows = await getDb().select().from(projectSteps)
      .where(and(eq(projectSteps.projectId, idA), eq(projectSteps.step, "outline")))
    expect(rows.length).toBe(0)

    // 选包 p1 → 放行，提纲生成成功（A 的 p1 就此锁定占用）
    await patchPackage(idA, { id: "p1", name: "包1" }, tokenA)
    const ok = await app.request(`/api/projects/${idA}/steps/outline`, { method: "POST", headers: auth(tokenA) })
    expect(ok.status).toBe(200)
    await ok.text()

    // GET /:id（slim 与 full）都下发 takenPackageIds；A 排除自己 → 空
    const detailA = (await (await app.request(`/api/projects/${idA}?slim=1`, { headers: auth(tokenA) })).json()) as { takenPackageIds: string[] }
    expect(detailA.takenPackageIds).toEqual([])

    // 克隆再投 p1（已生成）→ 409 package_taken；再投 p2 → 200
    const dupRes = await app.request(`/api/projects/${idA}/clone`, {
      method: "POST", headers: auth(tokenA), body: JSON.stringify({ package: { id: "p1", name: "包1" } }),
    })
    expect(dupRes.status).toBe(409)
    expect(((await dupRes.json()) as { error: string }).error).toBe("package_taken")
    const okClone = await app.request(`/api/projects/${idA}/clone`, {
      method: "POST", headers: auth(tokenA), body: JSON.stringify({ package: { id: "p2", name: "包2" } }),
    })
    expect(okClone.status).toBe(200)
    const idB = ((await okClone.json()) as { id: string }).id

    // B 视角：takenPackageIds 含 p1（A 已生成）；PATCH 改选 p1 → 409 package_taken；改选 p3 → 200
    const detailB = (await (await app.request(`/api/projects/${idB}?slim=1`, { headers: auth(tokenA) })).json()) as { takenPackageIds: string[] }
    expect(detailB.takenPackageIds).toEqual(["p1"])
    const grab = await patchPackage(idB, { id: "p1", name: "包1" }, tokenA)
    expect(grab.status).toBe(409)
    expect(((await grab.json()) as { error: string }).error).toBe("package_taken")
    const ok3 = await patchPackage(idB, { id: "p3", name: "包3" }, tokenA)
    expect(ok3.status).toBe(200)
  })
})
