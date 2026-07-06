import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { z } from "zod"
import { eq, and } from "drizzle-orm"
import { getDb } from "../db/client"
import { bidProjects, projectSteps } from "../db/schema"
import type { User } from "../db/schema"
import { authMiddleware } from "../middleware/auth"
import * as billing from "../services/billing-stub"
import * as client from "../services/agent-client"
import { getAgentModel } from "../services/agent-client"
import { toCamel } from "../lib/case"
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

// 编排依赖可注入（mock 测编排次序），默认真实 billing-stub / agent-client（与 read.ts 同法）。
export type ProjectDeps = {
  preDeduct: typeof billing.preDeduct
  settle: typeof billing.settle
  settleContent: typeof billing.settleContent
  settleFailed: typeof billing.settleFailed
  createRun: typeof client.createRun
  relayStream: typeof client.relayStream
  getRun: typeof client.getRun
  presignGet: typeof presignGet
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
  const createRun = deps.createRun ?? client.createRun
  const relayStream = deps.relayStream ?? client.relayStream
  const getRun = deps.getRun ?? client.getRun
  const presign = deps.presignGet ?? presignGet

  const r = new Hono<{ Variables: { user: User } }>()
  r.use("*", authMiddleware)

  // 建项目（上传招标文件拿到 fileKey 后调用）：一本标书一个 thread_id
  r.post("/", async (c) => {
    const parsed = z.object({ fileKey: z.string().min(1) }).safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
    const userId = c.get("user").id
    const threadId = `proj-${crypto.randomUUID()}`
    const [p] = await getDb()
      .insert(bidProjects)
      .values({ userId, threadId, tenderFileKey: parsed.data.fileKey })
      .returning()
    if (!p) return c.json({ error: "insert_failed" }, 500)
    return c.json({ id: p.id, threadId: p.threadId })
  })

  // 推进一步：预扣 → 建 run（同 thread）→ SSE 中继 → 存结果 → settle
  r.post("/:id/steps/:step", async (c) => {
    const { id, step } = c.req.param()
    if (!STEP_ORDER.includes(step as Step)) return c.json({ error: "bad_step" }, 400)
    const userId = c.get("user").id
    const [p] = await getDb()
      .select()
      .from(bidProjects)
      .where(and(eq(bidProjects.id, id), eq(bidProjects.userId, userId)))
    if (!p) return c.json({ error: "not_found" }, 404)

    // 跳步校验：只允许推进「当前步」（draft 项目限 read），避免与 agent checkpoint 顺序错位。
    const allowed = p.status === "draft" ? step === "read" : step === p.currentStep
    if (!allowed) return c.json({ error: "out_of_order", expected: p.currentStep }, 409)

    // 先落「running 占位行」再计费/建 run：部分唯一索引 (project_id, step) WHERE status='running'
    // 在 DB 层原子挡掉并发双击（第二个请求这里冲突 → 409，不会双建 run/双计费）。
    let s: typeof projectSteps.$inferSelect
    try {
      const [row] = await getDb()
        .insert(projectSteps)
        .values({ projectId: p.id, step, status: "running" })
        .returning()
      if (!row) return c.json({ error: "insert_failed" }, 500)
      s = row
    } catch {
      return c.json({ error: "step_already_running" }, 409)
    }

    // 真账本预扣（spec302）：ref=占位行 id（该次步进的稳定标识，幂等键随之稳定）。
    // 按真实配置键扣费：content 步预扣按上档 content_long（结算再落篇幅档），其余步用同名 credit_cost.<step>。
    // 余额不足 → 释放占位行，402。
    const hold = await preDeduct(userId, billing.holdOpForStep(step), s.id)
    if (!hold.ok) {
      await getDb().update(projectSteps).set({ status: "failed" }).where(eq(projectSteps.id, s.id))
      return c.json({ error: "insufficient" }, 402)
    }

    const input = { text: `${STEP_TEXT[step as Step]}，key=${p.tenderFileKey}`, file_key: p.tenderFileKey, step }
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
    // DB 存 snake_case 原样；给前端的经 toCamel 转 camelCase（对齐原型 TS 类型）
    await stream.writeSSE({
      event: "step.done",
      data: JSON.stringify({ step, cost, status: failed ? "failed" : "done", result: toCamel(run.result ?? null) }),
    })
  }

  // 查项目 + 各步结果（前端各页渲染；result 转 camelCase）
  r.get("/:id", async (c) => {
    const userId = c.get("user").id
    const [p] = await getDb()
      .select()
      .from(bidProjects)
      .where(and(eq(bidProjects.id, c.req.param("id")), eq(bidProjects.userId, userId)))
    if (!p) return c.json({ error: "not_found" }, 404)
    const steps = await getDb().select().from(projectSteps).where(eq(projectSteps.projectId, p.id))
    return c.json({ project: p, steps: steps.map((s) => ({ ...s, result: toCamel(s.result) })) })
  })

  // 产物下载：present/export 步的 result.artifacts[kind]（spec201 step.done 带 artifacts 合并快照），
  // 发预签名 URL，二进制不过 App。
  r.get("/:id/artifacts/:kind", async (c) => {
    const { id, kind } = c.req.param()
    if (!(kind in ARTIFACT_NAME)) return c.json({ error: "bad_kind" }, 400)
    const userId = c.get("user").id
    const [p] = await getDb()
      .select()
      .from(bidProjects)
      .where(and(eq(bidProjects.id, id), eq(bidProjects.userId, userId)))
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
