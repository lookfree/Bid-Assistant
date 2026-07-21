import { Hono } from "hono"
import { z } from "zod"
import { and, eq, isNull } from "drizzle-orm"
import { getDb } from "../db/client"
import { bidProjects, projectChecklists } from "../db/schema"
import type { User } from "../db/schema"
import { authMiddleware } from "../middleware/auth"
import { getUserId } from "../lib/auth-user"
import { isUuid } from "../lib/uuid"
import { toSnake } from "../lib/case"
import * as billing from "../services/billing-stub"
import * as client from "../services/agent-client"
import { presignGet } from "../storage/s3"

// 终极审核表（spec315b 契约 2/4）：状态/责任人/备注按 (userId, projectId) 一行持久化；
// projectId 可空 = 独立工具的用户级默认行（唯一约束 NULLS NOT DISTINCT，空与非空互不串行）。
// 导出走 agent 无状态渲染（export=20 分），计费编排照 rewrite 路由的非步独立计费范式。

// 单项状态：pass 通过 / risk 风险 / pending 待核（owner/note 串长设上限，防超大载荷灌库）
const itemSchema = z.object({
  status: z.enum(["pass", "risk", "pending"]),
  owner: z.string().max(200).optional(),
  note: z.string().max(200).optional(),
})

const putBodySchema = z.object({
  projectId: z.string().uuid().optional(),
  items: z.record(itemSchema).refine((o) => Object.keys(o).length <= 500), // {"<组id-序号>": {…}}，键数封顶
})

// 导出：groups 是透传给 agent 的形状（前端把模板+状态合成后传），只做外形门禁 + 大小上限
// （组 ≤26 / 每组项 ≤100 / 串长封顶），防超大载荷打穿 agent 渲染。
const exportItemSchema = z
  .object({
    text: z.string().max(500).optional(),
    status: z.string().max(500).optional(),
    owner: z.string().max(500).optional(),
    note: z.string().max(500).optional(),
    libraryHit: z.string().max(500).nullish(),
  })
  .passthrough()
const groupSchema = z
  .object({ id: z.string(), title: z.string().max(200), items: z.array(exportItemSchema).max(100) })
  .passthrough()
const exportBodySchema = z.object({
  projectId: z.string().uuid().optional(),
  title: z.string().max(200).optional(),
  groups: z.array(groupSchema).min(1).max(26),
})

// 编排依赖可注入（mock 测钱路径），默认真实 billing-stub / agent-client / s3（与 projects.ts 同法）。
export type ChecklistDeps = {
  preDeduct: typeof billing.preDeduct
  settle: typeof billing.settle
  settleFailed: typeof billing.settleFailed
  renderChecklist: typeof client.renderChecklist
  renderRiskReport: typeof client.renderRiskReport
  presignGet: typeof presignGet
}

// 废标体检报告导出请求体（免计费——体检 review 步已收费，导报告只是把已有结果落成文档）。
// 数据由前端从 review 结果映射（与报告弹层同源），串长/条数设上限防超大载荷。
const reportBodySchema = z.object({
  projectName: z.string().max(200).optional(),
  score: z.number().optional(),
  high: z.number().int().min(0).default(0),
  mid: z.number().int().min(0).default(0),
  passed: z.number().int().min(0).default(0),
  items: z
    .array(
      z.object({
        level: z.string().max(20).default(""),
        title: z.string().min(1).max(500),
        chapter: z.string().max(200).default(""),
        advice: z.string().max(2000).default(""),
      }),
    )
    .max(200)
    .default([]),
  passedItems: z.array(z.string().max(500)).max(200).default([]),
  format: z.enum(["docx", "pdf"]).default("docx"),
})

/** 属主校验取项目行：只见自己的，查不到与越权同语义（undefined → 调用方 404）。 */
async function ownedProject(id: string, userId: string) {
  const [p] = await getDb()
    .select()
    .from(bidProjects)
    .where(and(eq(bidProjects.id, id), eq(bidProjects.userId, userId)))
  return p
}

/** 取 (userId, projectId) 的审核表行；projectId 为 null 时命中用户级默认行。 */
async function checklistRow(userId: string, projectId: string | null) {
  const [row] = await getDb()
    .select()
    .from(projectChecklists)
    .where(
      and(
        eq(projectChecklists.userId, userId),
        projectId == null ? isNull(projectChecklists.projectId) : eq(projectChecklists.projectId, projectId),
      ),
    )
  return row
}

export function checklistRoutes(deps: Partial<ChecklistDeps> = {}) {
  const preDeduct = deps.preDeduct ?? billing.preDeduct
  const settle = deps.settle ?? billing.settle
  const settleFailed = deps.settleFailed ?? billing.settleFailed
  const renderChecklist = deps.renderChecklist ?? client.renderChecklist
  const renderRiskReport = deps.renderRiskReport ?? client.renderRiskReport
  const presign = deps.presignGet ?? presignGet

  const r = new Hono<{ Variables: { user: User } }>()
  r.use("*", authMiddleware)

  // 导出废标体检报告（免计费）：agent 无状态渲染 docx/pdf → 预签名（带下载名）。
  // 不占步位不动账本——绝不因导报告二次收费（体检本身已在 review 步计费）。
  r.post("/report", async (c) => {
    const parsed = reportBodySchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
    let out: { key: string; format: "docx" | "pdf" }
    try {
      out = await renderRiskReport(toSnake(parsed.data) as Record<string, unknown>)
    } catch {
      return c.json({ error: "agent_failed" }, 502)
    }
    // 下载名带项目名（剥掉内嵌的原始扩展名，同 artifacts 路由）；format 如实透传（pdf 可能回落 docx）
    const base = (parsed.data.projectName ?? "").replace(/\.(pdf|docx?|xlsx?|pptx?|zip|rar)(?=·|（|$)/i, "")
    const filename = `${base ? `${base}-` : ""}废标体检报告.${out.format}`
    const url = await presign(out.key, 300, filename)
    return c.json({ url, filename, format: out.format })
  })

  // 读审核表：?projectId= 可空（空串与缺省同义 = 用户级默认行）；无行返回空对象（前端全 pending 初始态）
  r.get("/", async (c) => {
    const userId = getUserId(c)
    const projectId = c.req.query("projectId") || null
    if (projectId != null) {
      if (!isUuid(projectId)) return c.json({ error: "not_found" }, 404) // 非 uuid 与不存在同语义
      if (!(await ownedProject(projectId, userId))) return c.json({ error: "not_found" }, 404)
    }
    const row = await checklistRow(userId, projectId)
    return c.json({ items: row?.items ?? {} })
  })

  // 写审核表：upsert 到 (user_id, project_id)——NULLS NOT DISTINCT 唯一约束保证空 projectId 也只有一行
  r.put("/", async (c) => {
    const parsed = putBodySchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
    const userId = getUserId(c)
    const projectId = parsed.data.projectId ?? null
    if (projectId != null && !(await ownedProject(projectId, userId))) return c.json({ error: "not_found" }, 404)
    await getDb()
      .insert(projectChecklists)
      .values({ userId, projectId, items: parsed.data.items })
      .onConflictDoUpdate({
        target: [projectChecklists.userId, projectChecklists.projectId],
        set: { items: parsed.data.items, updatedAt: new Date() },
      })
    return c.json({ ok: true })
  })

  // 导出 Word（真实计费 export=20）：hold → agent 无状态渲染 → 预签名 → settle 独立 try → {url, cost}
  r.post("/export", async (c) => {
    const parsed = exportBodySchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
    const userId = getUserId(c)

    // 一切可抛错的组装在预扣之前（照 rewrite 范式）：这里出错只是普通 4xx/500，无任何 hold 残留
    let projectName: string | undefined
    if (parsed.data.projectId) {
      const p = await ownedProject(parsed.data.projectId, userId)
      if (!p) return c.json({ error: "not_found" }, 404)
      projectName = p.name ?? undefined
    }
    const payload = {
      title: parsed.data.title ?? "终极审核表",
      projectName,
      groups: toSnake<unknown[]>(parsed.data.groups), // agent 吃 snake（library_hit 等键）
    }

    // 预扣 export 口径（credit_cost.export=20）；ref=本次导出的稳定标识（幂等键 hold:/settle:/release:<ref>）
    const ref = crypto.randomUUID()
    const hold = await preDeduct(userId, "export", ref)
    if (!hold.ok) return c.json({ error: "insufficient" }, 402)

    let key: string
    try {
      ;({ key } = await renderChecklist(payload))
    } catch {
      await settleFailed(ref, hold.holdId!).catch(() => {}) // agent 失败全额退还，净 0
      return c.json({ error: "agent_failed" }, 502)
    }

    let url: string
    try {
      // 带下载名：无 disposition 时浏览器按 key 的 uuid 命名且可能内联打开，用户找不到/认不出产物
      url = await presign(key, 300, "投递前终极审核表.docx")
    } catch (e) {
      // 预签名炸 = 用户没拿到产物 URL：退还预扣（净 0），不让用户为未交付的产物买单
      await settleFailed(ref, hold.holdId!).catch(() => {})
      throw e
    }

    // settle 独立于交付：URL 已到手，settle 瞬断**不能**退款（那会把已交付产物全额退掉）。
    // 只记日志人工对账；真孤儿 hold 由 24h 清扫（releaseOrphanHolds）兜底——宁少收不多收。
    let cost = hold.hold
    try {
      cost = await settle(ref, hold.holdId!, hold.hold)
    } catch (e) {
      console.error(`checklist export settle 失败（产物已交付，不退款，待对账）ref=${ref} holdId=${hold.holdId}`, e)
    }
    return c.json({ url, cost })
  })

  return r
}
