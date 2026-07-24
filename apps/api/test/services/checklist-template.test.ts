import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { and, eq, inArray } from "drizzle-orm"
import { ensureChecklistTemplate } from "../../src/services/checklist-template"
import { loginWithPhone } from "../../src/services/auth"
import { getDb, closeDb } from "../../src/db/client"
import { users, bidProjects, projectSteps, projectChecklists } from "../../src/db/schema"
import { uniquePhone, TEST_TIMEOUT_MS } from "../repos/helpers"

setDefaultTimeout(TEST_TIMEOUT_MS) // 连真库

// spec333 ensureChecklistTemplate：读标结论 → 模型生成 → 存 template。
// best-effort：无读标结果/模型未配置/生成失败 → null（前端回落默认 36），绝不抛错。

const READ = { project_meta: { name: "统一身份认证项目" }, risk_summary: ["未密封即废标"] }
const GROUPS = [
  { id: "A", title: "资格与资质", items: ["具备 ISO27001 且在有效期"] },
  { id: "B", title: "唯一性与合规", items: ["按要求密封"] },
]
const okModel = async () => ({ model: "deepseek-chat", chain: ["m1"] }) as never
const okGenerate = async () => ({ groups: GROUPS })

let userId = ""

async function newProject(withReadDone: boolean): Promise<string> {
  const [p] = await getDb()
    .insert(bidProjects)
    .values({ userId, threadId: `proj-${crypto.randomUUID()}` })
    .returning()
  if (withReadDone) {
    await getDb().insert(projectSteps).values({ projectId: p!.id, step: "read", status: "done", result: READ })
  }
  return p!.id
}

beforeAll(async () => {
  const a = await loginWithPhone(uniquePhone(), { agreedToTerms: true }, 30, async () => true)
  userId = a.user.id
})

afterAll(async () => {
  await getDb().delete(users).where(eq(users.id, userId)) // 项目/步/checklist 随 user 级联删
  await closeDb()
})

describe("ensureChecklistTemplate（spec333 定制审核表生成）", () => {
  it("① 无读标结果 → null（不调用模型/生成），前端回落默认 36", async () => {
    const projectId = await newProject(false)
    let called = false
    const out = await ensureChecklistTemplate(
      { userId, projectId },
      { getAgentModel: (async () => { called = true; return okModel() }) as never, generateChecklist: okGenerate },
    )
    expect(out).toBeNull()
    expect(called).toBe(false) // 无读标结果，短路在解析模型之前
  })

  it("② 模型未配置 → null（best-effort 不报错），不生成", async () => {
    const projectId = await newProject(true)
    let genCalled = false
    const out = await ensureChecklistTemplate(
      { userId, projectId },
      { getAgentModel: async () => undefined, generateChecklist: (async () => { genCalled = true; return { groups: GROUPS } }) as never },
    )
    expect(out).toBeNull()
    expect(genCalled).toBe(false)
  })

  it("③ 有读标+有模型 → 生成并持久化 template，返回 groups", async () => {
    const projectId = await newProject(true)
    const out = await ensureChecklistTemplate({ userId, projectId }, { getAgentModel: okModel, generateChecklist: okGenerate })
    expect(out).toEqual(GROUPS)
    const [row] = await getDb().select({ template: projectChecklists.template }).from(projectChecklists)
      .where(and(eq(projectChecklists.userId, userId), eq(projectChecklists.projectId, projectId)))
    expect(row?.template).toEqual(GROUPS) // 已落库
  })

  it("④ 已有 template → 直返、绝不重复调用模型（生成一次语义）", async () => {
    const projectId = await newProject(true)
    await ensureChecklistTemplate({ userId, projectId }, { getAgentModel: okModel, generateChecklist: okGenerate })
    let genCalled = false
    const out = await ensureChecklistTemplate(
      { userId, projectId },
      { getAgentModel: okModel, generateChecklist: (async () => { genCalled = true; return { groups: [] } }) as never },
    )
    expect(out).toEqual(GROUPS) // 仍是首次生成的模板
    expect(genCalled).toBe(false) // 未重复生成
  })

  it("⑤ 生成抛错 → null（吞错不反噬读标交付），不落库", async () => {
    const projectId = await newProject(true)
    const out = await ensureChecklistTemplate(
      { userId, projectId },
      { getAgentModel: okModel, generateChecklist: async () => { throw new Error("agent 502") } },
    )
    expect(out).toBeNull()
    const rows = await getDb().select().from(projectChecklists)
      .where(and(eq(projectChecklists.userId, userId), eq(projectChecklists.projectId, projectId)))
    expect(rows.length).toBe(0) // 未写入
  })

  it("⑥ 生成空表 → null（前端回落默认 36），不落库", async () => {
    const projectId = await newProject(true)
    const out = await ensureChecklistTemplate(
      { userId, projectId },
      { getAgentModel: okModel, generateChecklist: async () => ({ groups: [] }) },
    )
    expect(out).toBeNull()
  })
})
