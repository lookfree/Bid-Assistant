import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { z } from "zod"
import { eq, and, desc, sql } from "drizzle-orm"
import { getDb } from "../db/client"
import { bidProjects, projectSteps, projectFiles } from "../db/schema"
import type { User } from "../db/schema"
import { authMiddleware } from "../middleware/auth"
import { getUserId } from "../lib/auth-user"
import { isUuid } from "../lib/uuid"
import * as billing from "../services/billing-stub"
import * as client from "../services/agent-client"
import { healStuckStep } from "../services/stuck-steps"
import { getAgentModel } from "../services/agent-client"
import { toCamel, toSnake } from "../lib/case"
import { parsePagination, pagedBody, pagedResult } from "../lib/pagination"
import { presignGet } from "../storage/s3"

// 与 agent 节点序一致（spec201 NODE_ORDER）
export const STEP_ORDER = ["read", "outline", "content", "review", "present", "export"] as const
type Step = (typeof STEP_ORDER)[number]

// 按步指令：契约统一 { text, file_key, step }
const STEP_TEXT: Record<Step, string> = {
  read: "请对招标文件读标",
  outline: "请基于读标结果生成技术标/商务标提纲",
  content: "请基于提纲撰写正文各章节",
  review: "请对标书做合规体检与风险审查",
  present: "请生成述标稿与述标 PPT",
  export: "请导出完整标书 docx",
}

// 产物下载名（预签名 URL 的 Content-Disposition）
const ARTIFACT_NAME: Record<string, string> = { docx: "投标文件.docx", pptx: "述标演示.pptx" }

// 可编辑回写的步（spec315a 契约 1）：read/review/export 的 result 不接受前端覆写
const EDITABLE_STEPS = ["outline", "content", "present"] as const

// present 步的 run 参数（spec315a 契约 3）：时长限 10/15/20 分钟，模板限内置三款
const presentBodySchema = z.object({
  duration: z.union([z.literal(10), z.literal(15), z.literal(20)]).optional(),
  template: z.enum(["blue", "tech", "gov"]).optional(),
})

// 编辑回写请求体：非空 camelCase 对象（外形校验；按步结构校验见 STEP_RESULT_SCHEMAS）
const editBodySchema = z.object({
  result: z.record(z.unknown()).refine((o) => Object.keys(o).length > 0, "result 不能为空对象"),
})

// 按步结构校验（宽进：passthrough 保留未知键，只挡后续步/导出会炸的坏形状；
// 必填集与 agent schemas.py 的 Outline/DeckSpec 对齐）。校验只做门禁，落库仍用原始 result。
const outlineChapterSchema = z
  .object({
    id: z.string(),
    no: z.string(),
    title: z.string(),
    group: z.enum(["tech", "business"]),
    items: z.array(z.unknown()),
  })
  .passthrough()

const slideSchema = z
  .object({ id: z.string(), title: z.string(), kind: z.enum(["cover", "content", "end"]) })
  .passthrough()

const STEP_RESULT_SCHEMAS: Record<(typeof EDITABLE_STEPS)[number], z.ZodTypeAny> = {
  outline: z.object({ chapters: z.array(outlineChapterSchema) }).passthrough(),
  // content 步 result 是 { <章id>: html }：值必须全是字符串（render_docx 直接吃 html）
  content: z.record(z.string()),
  present: z
    .object({
      title: z.string(),
      duration: z.union([z.literal(10), z.literal(15), z.literal(20)]),
      template: z.enum(["blue", "tech", "gov"]),
      slides: z.array(slideSchema).min(1),
      qa: z.array(z.unknown()),
    })
    .passthrough(),
}

const rewriteBodySchema = z.object({ instruction: z.string().min(1) })

// 项目名：优先落库的 name（建项时取 project_files.filename 原始文件名）；
// 老数据兜底 key 的 basename（key 里是 sanitize 后的名，不做 decodeURIComponent——上传链路从不 URI 编码）。
function projectName(name: string | null, tenderFileKey: string | null): string {
  const base = tenderFileKey?.split("/").pop()
  return name ?? (base || "未命名项目")
}

// 编排依赖可注入（mock 测编排次序），默认真实 billing-stub / agent-client（与 read.ts 同法）。
export type ProjectDeps = {
  preDeduct: typeof billing.preDeduct
  settle: typeof billing.settle
  settleContent: typeof billing.settleContent
  settleFailed: typeof billing.settleFailed
  buildStateOverrides: typeof buildStateOverrides
  createRun: typeof client.createRun
  relayStream: typeof client.relayStream
  getRun: typeof client.getRun
  rewriteChapter: typeof client.rewriteChapter
  presignGet: typeof presignGet
}

/** 属主校验取项目行：只见自己的，查不到与越权同语义（undefined → 404）。 */
async function ownedProject(id: string, userId: string) {
  const [p] = await getDb()
    .select()
    .from(bidProjects)
    .where(and(eq(bidProjects.id, id), eq(bidProjects.userId, userId)))
  return p
}

/** 取该项目某步最新 done 行（result 现值 = 编辑过即编辑后；snake 原样）。 */
async function latestDoneStep(projectId: string, step: string) {
  const [row] = await getDb()
    .select()
    .from(projectSteps)
    .where(and(eq(projectSteps.projectId, projectId), eq(projectSteps.step, step), eq(projectSteps.status, "done")))
    .orderBy(desc(projectSteps.createdAt))
    .limit(1)
  return row
}

/** present 步 run 参数解析：只保留显式传入的 duration/template；非法值返回 null（调用方 400，不留占位行）。 */
function parsePresentInput(body: unknown): Record<string, unknown> | null {
  const parsed = presentBodySchema.safeParse(body)
  if (!parsed.success) return null
  const out: Record<string, unknown> = {}
  if (parsed.data.duration !== undefined) out.duration = parsed.data.duration
  if (parsed.data.template !== undefined) out.template = parsed.data.template
  return out
}

// 各步续跑前回灌的 state 键 → 来源步（chapters=content 步 result，deck=present 步 result）。
// review/present 也必须带 outline/chapters：否则体检/述标读的是 agent state 里的旧稿，与用户编辑分叉。
const OVERRIDE_SOURCES: Partial<Record<Step, Array<[overrideKey: string, from: Step]>>> = {
  content: [["outline", "outline"]],
  review: [["outline", "outline"], ["chapters", "content"]],
  present: [["outline", "outline"], ["chapters", "content"]],
  export: [["outline", "outline"], ["chapters", "content"], ["deck", "present"]],
}

/** 组 state_overrides（spec315a 契约 3）：App 把已存/已编辑的步结果回灌 agent state；
 *  对应步无 done 行则不带该键。result 存的是 snake，直接透传（agent 吃 snake）。 */
export async function buildStateOverrides(projectId: string, step: Step): Promise<Record<string, unknown>> {
  const overrides: Record<string, unknown> = {}
  for (const [k, st] of OVERRIDE_SOURCES[step] ?? []) {
    const row = await latestDoneStep(projectId, st)
    if (row?.result != null) overrides[k] = row.result
  }
  return overrides
}

/** content 步 result 是 { <章id>: html }，章 id 是 LLM 产的自由字符串（可能含下划线/大写）。
 *  大小写转换会把 id 键转坏（如 ch_1 → ch1），改写/导出就再也对不上——content 步一律原样透传。 */
function resultToClient(step: string, result: unknown): unknown {
  return step === "content" ? result : toCamel(result)
}

// content 步产出各章正文的最大字数（剥 HTML 标签后）——决定 content_short/long 分档。
// agent 的 _RESULT_KEY['content']='chapters'，故 run.result 即 { <章id>: html }。
function maxChapterChars(result: unknown): number {
  if (!result || typeof result !== "object") return 0
  let max = 0
  for (const v of Object.values(result as Record<string, unknown>)) {
    if (typeof v === "string") {
      const len = v.replace(/<[^>]+>/g, "").length
      if (len > max) max = len
    }
  }
  return max
}

export function projectRoutes(deps: Partial<ProjectDeps> = {}) {
  const preDeduct = deps.preDeduct ?? billing.preDeduct
  const settle = deps.settle ?? billing.settle
  const settleContent = deps.settleContent ?? billing.settleContent
  const settleFailed = deps.settleFailed ?? billing.settleFailed
  const stateOverrides = deps.buildStateOverrides ?? buildStateOverrides
  const createRun = deps.createRun ?? client.createRun
  const relayStream = deps.relayStream ?? client.relayStream
  const getRun = deps.getRun ?? client.getRun
  const rewriteChapter = deps.rewriteChapter ?? client.rewriteChapter
  const presign = deps.presignGet ?? presignGet

  const r = new Hono<{ Variables: { user: User } }>()
  r.use("*", authMiddleware)

  // 建项目（上传招标文件拿到 fileKey 后调用）：一本标书一个 thread_id
  r.post("/", async (c) => {
    const parsed = z.object({ fileKey: z.string().min(1) }).safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
    const userId = c.get("user").id
    const threadId = `proj-${crypto.randomUUID()}`
    // 项目名取上传时的原始 filename（key 里是 sanitize 后的名，不可反解）；查不到落 null 由列表兜底
    const [f] = await getDb()
      .select({ filename: projectFiles.filename })
      .from(projectFiles)
      .where(and(eq(projectFiles.key, parsed.data.fileKey), eq(projectFiles.userId, userId)))
    const [p] = await getDb()
      .insert(bidProjects)
      .values({ userId, threadId, tenderFileKey: parsed.data.fileKey, name: f?.filename ?? null })
      .returning()
    if (!p) return c.json({ error: "insert_failed" }, 500)
    return c.json({ id: p.id, threadId: p.threadId })
  })

  // 我的项目列表（分页，按创建时间倒序）。注意：必须先于 GET /:id 注册，否则被参数路由吞掉。
  r.get("/", async (c) => {
    let pg
    try {
      pg = parsePagination(c.req.query())
    } catch {
      return c.json({ error: "invalid_pagination" }, 400)
    }
    const where = eq(bidProjects.userId, getUserId(c)) // 只见自己的
    const { items, total } = await pagedResult(
      getDb().select().from(bidProjects).where(where).orderBy(desc(bidProjects.createdAt)).limit(pg.pageSize).offset(pg.offset),
      getDb().select({ n: sql<number>`count(*)` }).from(bidProjects).where(where),
    )
    const totalSteps = STEP_ORDER.length
    return c.json(
      pagedBody(pg, {
        items: items.map((p) => ({
          id: p.id,
          name: projectName(p.name, p.tenderFileKey),
          status: p.status,
          currentStep: p.currentStep,
          // done 表示整本完成（不在 STEP_ORDER 内）→ 进度打满；否则取当前步下标
          stepIndex: p.currentStep === "done" ? totalSteps : Math.max(STEP_ORDER.indexOf(p.currentStep as Step), 0),
          totalSteps,
          createdAt: p.createdAt,
        })),
        total,
      }),
    )
  })

  /** 占位行获取：插 running 占位行；撞唯一索引先惰性自愈——既有行已死（超 10 分钟 /
   *  其 run 已失败：DB 断连等导致收尾没执行，行永远卡 running、该步恒 409）则当场
   *  置 failed + 退还其预扣（stuck-steps 服务），重试一次插入；活行/重试仍冲突返回 null → 409。 */
  async function acquireStepSlot(projectId: string, step: string): Promise<typeof projectSteps.$inferSelect | null> {
    const insert = async () => {
      const [row] = await getDb().insert(projectSteps).values({ projectId, step, status: "running" }).returning()
      return row ?? null
    }
    try {
      return await insert()
    } catch {
      const healed = await healStuckStep(projectId, step, getRun)
      if (!healed) return null
      try {
        return await insert()
      } catch {
        return null // 并发请求抢先重建了占位行：如实 409
      }
    }
  }

  // 推进一步：预扣 → 建 run（同 thread）→ SSE 中继 → 存结果 → settle
  r.post("/:id/steps/:step", async (c) => {
    const { id, step } = c.req.param()
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404) // 非 uuid 直接 404，避免 PG 22P02 → 500
    if (!STEP_ORDER.includes(step as Step)) return c.json({ error: "bad_step" }, 400)

    // 本 run 参数（spec315a 契约 3）：仅 present 步接受 {duration, template}，先于占位行校验（400 不留残行）
    const runInput = step === "present" ? parsePresentInput(await c.req.json().catch(() => ({}))) : {}
    if (!runInput) return c.json({ error: "invalid_input" }, 400)

    const userId = c.get("user").id
    const p = await ownedProject(id, userId)
    if (!p) return c.json({ error: "not_found" }, 404)

    // 跳步校验：只允许推进「当前步」（draft 项目限 read），避免与 agent checkpoint 顺序错位。
    const allowed = p.status === "draft" ? step === "read" : step === p.currentStep
    if (!allowed) return c.json({ error: "out_of_order", expected: p.currentStep }, 409)

    // spec315a 契约 3：input 扩为五键——run_input（本 run 参数）+ state_overrides（已存/已编辑结果回灌 state）。
    // 组装必须在占位行/预扣**之前**完成（它不依赖 hold）：若放在预扣之后，DB 抖动抛错会让 hold 冻结、
    // running 占位行永久卡死（部分唯一索引让重试恒 409）。这里抛错只是普通 500，无任何残留。
    const input = {
      text: `${STEP_TEXT[step as Step]}，key=${p.tenderFileKey}`,
      file_key: p.tenderFileKey,
      step,
      run_input: runInput,
      state_overrides: await stateOverrides(p.id, step as Step),
    }

    // 先落「running 占位行」再计费/建 run：部分唯一索引 (project_id, step) WHERE status='running'
    // 在 DB 层原子挡掉并发双击（第二个请求这里冲突 → 惰性自愈失败才 409，不会双建 run/双计费）。
    const s = await acquireStepSlot(p.id, step)
    if (!s) return c.json({ error: "step_already_running" }, 409)

    // 真账本预扣（spec302）：ref=占位行 id（该次步进的稳定标识，幂等键随之稳定）。
    // 按真实配置键扣费：content 步预扣按上档 content_long（结算再落篇幅档），其余步用同名 credit_cost.<step>。
    // 余额不足 → 释放占位行，402。
    const hold = await preDeduct(userId, billing.holdOpForStep(step), s.id)
    if (!hold.ok) {
      await getDb().update(projectSteps).set({ status: "failed" }).where(eq(projectSteps.id, s.id))
      return c.json({ error: "insufficient" }, 402)
    }
    let run_id: string
    try {
      const model = await getAgentModel() // 运营后台可配的 agent 模型选择（spec311）
      ;({ run_id } = await createRun({ agentType: "bidding_agent", threadId: p.threadId, input, model }))
      await getDb().update(projectSteps).set({ runId: run_id }).where(eq(projectSteps.id, s.id))
    } catch (e) {
      // agent 服务不可达等：释放占位行为 failed，可立即重试
      await getDb().update(projectSteps).set({ status: "failed" }).where(eq(projectSteps.id, s.id))
      throw e
    }

    return streamSSE(c, async (stream) => {
      try {
        for await (const chunk of relayStream(run_id)) await stream.write(chunk) // 透传 agent SSE
        await finishStep(stream, { project: p, stepRow: s, step: step as Step, runId: run_id, hold })
      } catch (e) {
        // 中继/收尾中途炸（agent 掉线等）：退还预扣（已结算则被了结唯一索引吞掉）+ 占位行标 failed
        await settleFailed(s.id, hold.holdId!).catch(() => {})
        await getDb().update(projectSteps).set({ status: "failed" }).where(eq(projectSteps.id, s.id))
        await stream.writeSSE({
          event: "step.done",
          data: JSON.stringify({ step, cost: 0, status: "failed", error: String(e) }),
        })
      }
    })
  })

  /** 步进收尾：取 run 终态 → 结算/退还 → 落步结果 → 推进 currentStep → 发 step.done。 */
  async function finishStep(
    stream: { writeSSE: (m: { event: string; data: string }) => Promise<void> },
    ctx: {
      project: typeof bidProjects.$inferSelect
      stepRow: typeof projectSteps.$inferSelect
      step: Step
      runId: string
      hold: { holdId?: string; hold: number }
    },
  ) {
    const { project, stepRow, step, runId, hold } = ctx
    const run = await getRun(runId) // 该步结构化结果（snake_case）
    const failed = run.status !== "succeeded"
    // 成功按口径全额结算；失败全额退还（净 0）——多退少补待用量换算口径定义
    let cost = 0
    if (failed) {
      await settleFailed(stepRow.id, hold.holdId!)
    } else if (step === "content") {
      // 按篇幅落档：任一章 > 阈值 → 长篇（足额 content_long）；否则短篇 content_short（退差额）。
      cost = await settleContent(stepRow.id, hold.holdId!, hold.hold, maxChapterChars(run.result))
    } else {
      cost = await settle(stepRow.id, hold.holdId!, hold.hold)
    }
    await getDb()
      .update(projectSteps)
      .set({ result: run.result ?? null, status: failed ? "failed" : "done", costPoints: cost })
      .where(eq(projectSteps.id, stepRow.id))
    if (!failed) {
      // 推进 currentStep；最后一步完成即整本 done
      const next = STEP_ORDER[STEP_ORDER.indexOf(step) + 1]
      await getDb()
        .update(bidProjects)
        .set({ currentStep: next ?? "done", status: next ? "running" : "done" })
        .where(eq(bidProjects.id, project.id))
    }
    // DB 存 snake_case 原样；给前端的经 toCamel 转 camelCase（对齐原型 TS 类型）。
    // content 步例外：result 键是章 id，不做大小写转换（见 resultToClient）。
    await stream.writeSSE({
      event: "step.done",
      data: JSON.stringify({ step, cost, status: failed ? "failed" : "done", result: resultToClient(step, run.result ?? null) }),
    })
  }

  // 编辑回写（spec315a 契约 1）：前端编辑后的提纲/正文/幻灯片覆写该步 done 行的 result。
  // body {result}（camelCase）→ toSnake 落库（DB 与 agent 契约都是 snake 原样；content 步键为章 id 原样存）；
  // 后续步/导出经 state_overrides 吃到编辑后值。
  r.patch("/:id/steps/:step", async (c) => {
    const { id, step } = c.req.param()
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404) // 非 uuid 直接 404，避免 PG 22P02 → 500
    if (!(EDITABLE_STEPS as readonly string[]).includes(step)) return c.json({ error: "bad_step" }, 400)
    const p = await ownedProject(id, c.get("user").id)
    if (!p) return c.json({ error: "not_found" }, 404)
    const parsed = editBodySchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
    // 按步结构校验：坏形状（缺必填/枚举越界/空 slides…）会让后续步或导出直接炸，这里挡 400。
    const shape = STEP_RESULT_SCHEMAS[step as (typeof EDITABLE_STEPS)[number]].safeParse(parsed.data.result)
    if (!shape.success) return c.json({ error: "invalid_result" }, 400)
    const row = await latestDoneStep(p.id, step)
    if (!row) return c.json({ error: "step_not_done" }, 404) // 该步没跑完（无 done 行）不可编辑
    // content 步的键是章 id（LLM 自由字符串），不做大小写转换（对称：读侧 resultToClient 同样跳过）
    const stored = step === "content" ? parsed.data.result : toSnake(parsed.data.result)
    await getDb().update(projectSteps).set({ result: stored }).where(eq(projectSteps.id, row.id))
    return c.json({ ok: true })
  })

  // 单章改写（spec315a 契约 2，真实计费）：hold(rewrite=25) → agent 同步改写 → 持久化 → settle 足额；
  // 失败 settleFailed 净 0。chapterId 是 agent 章节 id（字符串，非 uuid，不做 uuid 校验）。
  r.post("/:id/chapters/:chapterId/rewrite", async (c) => {
    const { id, chapterId } = c.req.param()
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404) // 非 uuid 直接 404，避免 PG 22P02 → 500
    const userId = c.get("user").id
    const p = await ownedProject(id, userId)
    if (!p) return c.json({ error: "not_found" }, 404)
    const parsed = rewriteBodySchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
    // content 步必须已完成才有章可改（result 即 { <章id>: html } 的 chapters 字典）
    const contentRow = await latestDoneStep(p.id, "content")
    if (!contentRow) return c.json({ error: "content_not_done" }, 409)
    // 改写底稿用 DB 现值（编辑过=编辑后），别让 agent 拿 state 里的旧稿改（编辑会被吃掉）
    const baseHtml = (contentRow.result as Record<string, unknown> | null)?.[chapterId]
    const model = await getAgentModel() // 运营后台切换的模型对 rewrite 同样生效（spec311）；预扣前取，抛错无残留

    // 预扣 rewrite 口径（credit_cost.rewrite=25）；ref=本次改写的稳定标识（幂等键 hold:/settle:/release:<ref> 随之稳定）
    const ref = crypto.randomUUID()
    const hold = await preDeduct(userId, "rewrite", ref)
    if (!hold.ok) return c.json({ error: "insufficient" }, 402)

    let html: string
    try {
      ;({ html } = await rewriteChapter({
        agentType: "bidding_agent",
        threadId: p.threadId,
        chapterId,
        instruction: parsed.data.instruction,
        baseHtml: typeof baseHtml === "string" ? baseHtml : undefined,
        model,
      }))
    } catch {
      await settleFailed(ref, hold.holdId!).catch(() => {}) // 失败全额退还，净 0
      return c.json({ error: "agent_failed" }, 502)
    }

    try {
      // 持久化：content 步 result 就是 chapters 字典（agent _RESULT_KEY['content']='chapters'）。
      // agent 调用长达 ~120s，期间用户可能 PATCH 了其他章——必须在事务内 FOR UPDATE 重读该行，
      // 把本章 merge 进**新鲜** result 再写回；用请求开始的旧快照整份写回会回滚并发编辑。
      await getDb().transaction(async (tx) => {
        const [fresh] = await tx.select().from(projectSteps).where(eq(projectSteps.id, contentRow.id)).for("update")
        const chapters = { ...((fresh?.result as Record<string, unknown>) ?? {}), [chapterId]: html }
        await tx.update(projectSteps).set({ result: chapters }).where(eq(projectSteps.id, contentRow.id))
      })
    } catch (e) {
      // 持久化炸：产物没落库，退还预扣（净 0），不让用户为未交付的产物买单
      await settleFailed(ref, hold.holdId!).catch(() => {})
      throw e
    }

    // settle 独立于持久化：产物已交付，settle 瞬断**不能**走 settleFailed（那会把已交付产物全额退款）。
    // 只记日志人工对账；真孤儿 hold 由 24h 清扫（releaseOrphanHolds）兜底释放——宁少收不多收。
    let cost = hold.hold
    try {
      cost = await settle(ref, hold.holdId!, hold.hold) // 成功足额结算
    } catch (e) {
      console.error(`rewrite settle 失败（产物已交付，不退款，待对账）ref=${ref} holdId=${hold.holdId}`, e)
    }
    return c.json({ chapterId, html, cost })
  })

  // 查项目 + 各步结果（前端各页渲染；result 转 camelCase，content 步键为章 id 原样透传）
  r.get("/:id", async (c) => {
    const id = c.req.param("id")
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404) // 非 uuid 直接 404，避免 PG 22P02 → 500
    const p = await ownedProject(id, c.get("user").id)
    if (!p) return c.json({ error: "not_found" }, 404)
    const steps = await getDb().select().from(projectSteps).where(eq(projectSteps.projectId, p.id))
    return c.json({ project: p, steps: steps.map((s) => ({ ...s, result: resultToClient(s.step, s.result) })) })
  })

  // 产物下载：present/export 步的 result.artifacts[kind]（spec201 step.done 带 artifacts 合并快照），
  // 发预签名 URL，二进制不过 App。
  r.get("/:id/artifacts/:kind", async (c) => {
    const { id, kind } = c.req.param()
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404) // 非 uuid 直接 404，避免 PG 22P02 → 500
    if (!(kind in ARTIFACT_NAME)) return c.json({ error: "bad_kind" }, 400)
    const p = await ownedProject(id, c.get("user").id)
    if (!p) return c.json({ error: "not_found" }, 404)
    const steps = await getDb().select().from(projectSteps).where(eq(projectSteps.projectId, p.id))
    // export 步的 result 即 BiddingState.artifacts 合并快照（顶层 {docx,pptx}）；
    // 兼容嵌套 result.artifacts 形态（防上游契约演化），两处都找。
    const key = steps
      .map((s) => {
        const r = s.result as { artifacts?: Record<string, unknown>; [k: string]: unknown } | null
        const v = r?.artifacts?.[kind] ?? r?.[kind]
        return typeof v === "string" ? v : undefined
      })
      .find((k): k is string => typeof k === "string")
    if (!key) return c.json({ error: "artifact_not_ready" }, 404)
    return c.json({ url: await presign(key, 300, ARTIFACT_NAME[kind]) })
  })

  return r
}
