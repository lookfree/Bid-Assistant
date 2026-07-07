import { Hono } from "hono"
import { z } from "zod"
import { and, eq, inArray } from "drizzle-orm"
import { getDb } from "../db/client"
import { projectFiles, dedupeRuns } from "../db/schema"
import type { User } from "../db/schema"
import { authMiddleware } from "../middleware/auth"
import { toCamel } from "../lib/case"
import * as billing from "../services/billing-stub"
import * as client from "../services/agent-client"
import { AgentHttpError } from "../services/agent-client"

// 标书查重（spec315b 契约 3）：App 只做鉴权 + 计费编排 + 中继（agent money-blind）。
// 口径 = UI 锁死文案：仅本次上传的 2-3 份投标文件之间两两比对（可选招标文件基线扣除），非全网/非历史库。
// 计费照 rewrite 路由的非步独立范式：hold(dedupe=100) → agent → settle 独立 try；失败 settleFailed 净 0。

const bodySchema = z
  .object({
    fileKeys: z.array(z.string()).min(2).max(3),
    tenderKey: z.string().optional(),
    dims: z.array(z.enum(["text", "image", "meta", "baseline"])).min(1),
    strategy: z.enum(["fast", "standard", "strict"]),
  })
  // fileKeys 必须互异且不含 tenderKey：同一文件自比无意义，不该收 100 分（在预扣前拦下）
  .refine(
    (b) => new Set(b.fileKeys).size === b.fileKeys.length && (!b.tenderKey || !b.fileKeys.includes(b.tenderKey)),
    { message: "invalid_files" },
  )

// 编排依赖可注入（mock 测钱路径），默认真实 billing-stub / agent-client（与 projects.ts 同法）。
export type DedupeDeps = {
  preDeduct: typeof billing.preDeduct
  settle: typeof billing.settle
  settleFailed: typeof billing.settleFailed
  dedupe: typeof client.dedupe
}

export function dedupeRoutes(deps: Partial<DedupeDeps> = {}) {
  const preDeduct = deps.preDeduct ?? billing.preDeduct
  const settle = deps.settle ?? billing.settle
  const settleFailed = deps.settleFailed ?? billing.settleFailed
  const dedupe = deps.dedupe ?? client.dedupe

  const r = new Hono<{ Variables: { user: User } }>()
  r.use("*", authMiddleware)

  r.post("/", async (c) => {
    const parsed = bodySchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      // refine 失败（重复 fileKey / tenderKey 混入）与属主校验同语义 → invalid_files；其余 invalid_input
      const dupKeys = parsed.error.issues.some((i) => i.message === "invalid_files")
      return c.json({ error: dupKeys ? "invalid_files" : "invalid_input" }, 400)
    }
    const userId = c.get("user").id
    const body = parsed.data

    // 每个 fileKey（含 tenderKey）属主校验：必须是本人已上传完成（status=uploaded）的文件；
    // 非本人/不存在/未完成一律 400 invalid_files（不触计费，也不向 agent 泄露他人对象 key）。
    const keys = [...new Set([...body.fileKeys, ...(body.tenderKey ? [body.tenderKey] : [])])]
    const rows = await getDb()
      .select({ key: projectFiles.key, filename: projectFiles.filename })
      .from(projectFiles)
      .where(and(eq(projectFiles.userId, userId), inArray(projectFiles.key, keys), eq(projectFiles.status, "uploaded")))
    const nameByKey = new Map(rows.map((f) => [f.key, f.filename]))
    if (keys.some((k) => !nameByKey.has(k))) return c.json({ error: "invalid_files" }, 400)

    // 组装 agent 载荷（label=上传原始文件名，结果 pairs 的 a/b 以此可读展示）——照 rewrite 范式，
    // 一切可抛错的组装在预扣之前完成，出错无任何 hold 残留。
    const payload = {
      files: body.fileKeys.map((k) => ({ key: k, label: nameByKey.get(k)! })),
      tenderKey: body.tenderKey,
      dims: body.dims,
      strategy: body.strategy,
    }

    // 预扣 dedupe 口径（credit_cost.dedupe=100）；ref=本次查重的稳定标识（幂等键随之稳定）
    const ref = crypto.randomUUID()
    const hold = await preDeduct(userId, "dedupe", ref)
    if (!hold.ok) return c.json({ error: "insufficient" }, 402)

    let result: Awaited<ReturnType<typeof client.dedupe>>
    try {
      result = await dedupe(payload)
    } catch (e) {
      await settleFailed(ref, hold.holdId!).catch(() => {}) // 失败全额退还，净 0
      // agent 422 = 某文件解析失败（业务态 {error, file}）：退钱后透传给前端；其余一律 502
      if (e instanceof AgentHttpError && e.status === 422) {
        return c.json((e.body as Record<string, unknown>) ?? { error: "parse_failed" }, 422)
      }
      return c.json({ error: "agent_failed" }, 502)
    }

    // settle 独立于交付：结果已拿到，settle 瞬断**不能**退款（那会把已交付结果全额退掉）。
    // 只记日志人工对账；真孤儿 hold 由 24h 清扫兜底——宁少收不多收。
    let cost = hold.hold
    try {
      cost = await settle(ref, hold.holdId!, hold.hold)
    } catch (e) {
      console.error(`dedupe settle 失败（结果已交付，不退款，待对账）ref=${ref} holdId=${hold.holdId}`, e)
    }

    // 审计行（花了 100 分的操作要可追溯）：落库失败只记日志，不因审计扣下用户已付费的结果
    try {
      await getDb().insert(dedupeRuns).values({ userId, params: body, result, cost })
    } catch (e) {
      console.error(`dedupe 审计行落库失败 ref=${ref} userId=${userId}`, e)
    }

    return c.json(toCamel(result)) // agent 结果原样返回（snake → camelCase）
  })

  return r
}
