import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { z } from "zod"
import { eq, and, inArray } from "drizzle-orm"
import { getDb } from "../db/client"
import { agentRuns, projectFiles } from "../db/schema"
import type { User } from "../db/schema"
import { authMiddleware } from "../middleware/auth"
import * as billing from "../services/billing-stub"
import * as client from "../services/agent-client"
import { getAgentModel } from "../services/agent-client"
import { ragRunInput } from "../services/rag-config"

// 编排依赖可注入（mock 测编排次序），默认用真实 billing-stub / agent-client。
export type ReadDeps = {
  preDeduct: typeof billing.preDeduct
  settle: typeof billing.settle
  settleFailed: typeof billing.settleFailed
  createRun: typeof client.createRun
  relayStream: typeof client.relayStream
  getRun: typeof client.getRun
}

// spec320：接受多文件 fileKeys 或旧单文件 fileKey（至少一个）；本端点不做属主校验（历史行为，未收窄）。
const bodySchema = z
  .object({
    fileKey: z.string().min(1).optional(),
    fileKeys: z.array(z.string().min(1)).min(1).max(10).optional(),
  })
  .refine((v) => !!v.fileKey || !!v.fileKeys, "fileKey 或 fileKeys 至少一个")

/** run input 的 files 字段：文件名查 project_files（找不到兜底 key 的 basename）。 */
async function filesForKeys(keys: string[]): Promise<Array<{ key: string; name: string }>> {
  const rows = await getDb().select({ key: projectFiles.key, filename: projectFiles.filename }).from(projectFiles).where(inArray(projectFiles.key, keys))
  const nameByKey = new Map(rows.map((f) => [f.key, f.filename]))
  return keys.map((k) => ({ key: k, name: nameByKey.get(k) ?? k.split("/").pop() ?? k }))
}

export function readRoutes(deps: Partial<ReadDeps> = {}) {
  const preDeduct = deps.preDeduct ?? billing.preDeduct
  const settle = deps.settle ?? billing.settle
  const settleFailed = deps.settleFailed ?? billing.settleFailed
  const createRun = deps.createRun ?? client.createRun
  const relayStream = deps.relayStream ?? client.relayStream
  const getRun = deps.getRun ?? client.getRun

  const r = new Hono<{ Variables: { user: User } }>()
  r.use("*", authMiddleware) // 读标属本人，需登录

  // 上传招标文件后（已有 fileKey）触发读标：预扣 → 建 run → SSE 中继 → 存结果 → settle
  r.post("/", async (c) => {
    const parsed = bodySchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
    const keys = parsed.data.fileKeys ?? [parsed.data.fileKey!]
    const fileKey = keys[0] // 首个 key（向后兼容旧 agent 契约）
    const userId = c.get("user").id
    const threadId = `proj-${crypto.randomUUID()}`

    const hold = await preDeduct(userId, "read", threadId) // 真账本预扣（ref=threadId，一次读标一个 thread）
    if (!hold.ok) return c.json({ error: "insufficient" }, 402)

    const model = await getAgentModel() // 运营后台可配的 agent 模型选择（spec311）
    const { run_id } = await createRun({
      agentType: "bidding_agent",
      threadId,
      // 契约统一 { text, file_key, step }：text 为按步指令，key 也写进 text（避免 agent 端 input.text 落空）
      // files（spec320）：全部招标文件；run_input.rag（spec316）：读标节点检索个人资料库时按 user_id 隔离
      input: {
        text: `请对招标文件读标，key=${fileKey}`,
        file_key: fileKey,
        files: await filesForKeys(keys),
        step: "read",
        run_input: { rag: await ragRunInput() },
      },
      model,
      userId,
    })
    await getDb()
      .insert(agentRuns)
      .values({ userId, agentType: "bidding_agent", runId: run_id, threadId, status: "running" })

    return streamSSE(c, async (stream) => {
      // 同 projects 步进流：客户端断连不改变 run/账务终态，写失败静默丢弃、继续等 run 真实结果。
      let clientGone = false
      const safeWrite = async (chunk: string) => {
        if (clientGone) return
        try { await stream.write(chunk) } catch { clientGone = true }
      }
      try {
        for await (const chunk of relayStream(run_id)) await safeWrite(chunk) // 透传 agent SSE
        const run = await getRun(run_id) // 取六大分类结果
        const failed = run.status !== "succeeded"
        let cost = 0
        if (failed) {
          await settleFailed(threadId, hold.holdId!)
        } else {
          cost = await settle(threadId, hold.holdId!, hold.hold)
        }
        await getDb()
          .update(agentRuns)
          .set({ status: failed ? "failed" : "done", result: run.result ?? null, costPoints: cost })
          .where(eq(agentRuns.runId, run_id))
        if (!clientGone) {
          try {
            await stream.writeSSE({ event: "done", data: JSON.stringify({ runId: run_id, cost, status: failed ? "failed" : "done" }) })
          } catch { clientGone = true }
        }
      } catch {
        // 中继/收尾中途炸：退还预扣（若已 settle 则被"每 hold 一条了结"唯一索引吞掉，不会双返还）+ run 标 failed
        await settleFailed(threadId, hold.holdId!).catch(() => {})
        await getDb().update(agentRuns).set({ status: "failed" }).where(eq(agentRuns.runId, run_id))
      }
    })
  })

  r.get("/runs/:id", async (c) => {
    // 属主隔离：只允许读本人的 run（否则任意登录用户可越权读他人读标结果）
    const [row] = await getDb()
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.runId, c.req.param("id")), eq(agentRuns.userId, c.get("user").id)))
    if (!row) return c.json({ error: "not_found" }, 404)
    return c.json(row) // 前端 /read 渲染 row.result
  })

  return r
}
