import { and, desc, eq, gt, inArray, lt } from "drizzle-orm"
import { getDb } from "../db/client"
import { markExportDirty, clearExportDirty } from "./export-dirty"
import { bidProjects, creditTransactions, projectSteps } from "../db/schema"
import * as billing from "./billing-stub"
import { failStepAndRefund, STUCK_STEP_MAX_AGE_MS } from "./stuck-steps"
import { syncCredentialsOutline } from "./credentials-chapter"

// 步进收尾核心（spec327 janitor 加固）：SSE 请求路径、409 惰性自愈、对账 Cron 三处共用同一
// 收尾函数——生产顽疾是「run 已成功而 App 收尾被发版/断连打断」，旧自愈只会判死退款,把
// Redis 里还活着的成功结果白白扔掉,用户被迫重跑重付。这里的原则:
//   ① 成功 run 的结果必须交付,不允许「杀成功」;
//   ② 死活以 agent 的 run 状态为准（agent 有心跳清道夫）,不再按行龄盲杀;
//   ③ 一切了结动作幂等（settle:<stepId>/release:<stepId> + 条件翻转做并发唯一了结点）。

// 与 agent 节点序一致（spec201 NODE_ORDER）；routes/projects.ts 从这里 re-export。
export const STEP_ORDER = ["read", "outline", "content", "review", "present", "export"] as const
export type Step = (typeof STEP_ORDER)[number]

/** agent run 探针（agent-client.getRun 兼容子集；测试注入 mock）。status null=run 确实不存在
 *  （agent 404）——区别于「agent 不可达」（getRun 抛错）,两者的判死语义完全不同。 */
export type RunProbe = { status: string | null; result?: unknown }
export type GetRunFn = (runId: string) => Promise<RunProbe>

/** 结算依赖可注入（对齐 routes 的 deps 注入法，测编排次序）。 */
export type FinalizeBilling = {
  settle: typeof billing.settle
  settleContent: typeof billing.settleContent
}

/** content 步本次产出的正文总字数（剥 HTML 标签后各章求和）——决定落到哪个计费档。
 *  agent 的 _RESULT_KEY['content']='chapters'，故 run.result 即 { <章id>: html }。
 *  口径是「整本标书的总字数」，不是最长一章：一次 run 写完全部章节、只计一次费。 */
export function totalChapterChars(result: unknown): number {
  if (!result || typeof result !== "object") return 0
  let total = 0
  for (const v of Object.values(result as Record<string, unknown>)) {
    if (typeof v === "string") total += v.replace(/<[^>]+>/g, "").length
  }
  return total
}

/** agent 长期不可达时的最终兜底判死线（与账本孤儿 hold 清扫同一 24h 视界）。 */
export const UNREACHABLE_KILL_AGE_MS = 24 * 3600_000

/** 收尾的「结算+计费落库+推进」段。全程幂等可重放（settle:<stepId> 键 + 条件推进）：
 *  翻转 done 之后任何一步崩溃留下的「done 且 costPoints 为空」半收尾行,由对账 Cron
 *  用同一函数补齐——否则项目会永久卡在旧 currentStep（下一步恒 409）且 hold 冻结。 */
async function settleAndAdvance(opts: {
  stepId: string
  projectId: string
  step: Step
  result: unknown
  hold: { holdId: string; heldAmount: number } | null
  runStartedAt: Date        // 步位行创建时刻：导出收尾据此判断本次 run 期间内容有没有被改过
  billing?: FinalizeBilling
}): Promise<number> {
  const b = opts.billing ?? billing
  // hold 缺失（理论不可达:预扣在建 run 之前）:结果照常交付,计 0 费——绝不因账务疑难扣押结果。
  let cost = 0
  if (opts.hold) {
    cost = opts.step === "content"
      ? await b.settleContent(opts.stepId, opts.hold.holdId, opts.hold.heldAmount, totalChapterChars(opts.result))
      : await b.settle(opts.stepId, opts.hold.holdId, opts.hold.heldAmount)
  }
  await getDb().update(projectSteps).set({ costPoints: cost }).where(eq(projectSteps.id, opts.stepId))
  // 导出计费脏标记（2026-07-31 口径）：重跑提纲/正文=内容变了→置脏；导出成功→清净。
  // 放在这里而不是 finalizeStepSuccess：sweepStuckSteps 的半收尾修复（R1/R2）直接调 settleAndAdvance，
  // 挂在上层会漏掉那条路——进程在「翻 done」与「清净」之间挂掉（部署打断导出是复发事件），
  // 修复后标记仍是脏的，用户下次原样重下会被二次收费。
  if (opts.step === "outline" || opts.step === "content") await markExportDirty(opts.projectId)
  else if (opts.step === "export") await clearExportDirty(opts.projectId, opts.runStartedAt)
  const [proj] = await getDb().select({ kind: bidProjects.kind }).from(bidProjects).where(eq(bidProjects.id, opts.projectId))
  const next = nextStepFor(opts.step, proj?.kind ?? "bid")
  await getDb()
    .update(bidProjects)
    .set({ currentStep: next ?? "done", status: next ? "running" : "done" })
    .where(and(eq(bidProjects.id, opts.projectId), advanceGuard(opts.step)))
  return cost
}

/** 步进表按项目类型分叉（spec328）：review-kind 只有 read→review→done;bid 走完整流水线。 */
function nextStepFor(step: Step, kind: string): Step | undefined {
  if (kind === "review") return step === "read" ? "review" : undefined
  return STEP_ORDER[STEP_ORDER.indexOf(step) + 1]
}

/** 条件推进的 WHERE 守卫：常规=停在本步才推进（幂等/并发安全）。
 *  export 例外（述标与体检均可跳过）：停在 review（跳过体检直出）或 present（跳过述标直出）时，
 *  export 完成也要推到 done——否则项目永远停 running。present/review 在 done 后补跑时本守卫
 *  不匹配（currentStep=done），不会把已完成项目回退到 export，正是想要的。 */
function advanceGuard(step: Step) {
  return step === "export"
    ? inArray(bidProjects.currentStep, ["review", "present", "export"])
    : eq(bidProjects.currentStep, step)
}

/** 成功收尾核心：条件翻转 running→done（result 同条 UPDATE 落库,翻转即交付）作并发唯一
 *  了结点——翻转失败=别处已收尾,返回 null。翻转成功后 settleAndAdvance（结算/计费/推进,
 *  幂等可由对账 Cron 补齐,见上）。方向性:宁可少收钱,不丢用户结果。 */
export async function finalizeStepSuccess(opts: {
  stepId: string
  projectId: string
  step: Step
  result: unknown
  holdId: string | null
  heldAmount: number
  billing?: FinalizeBilling
}): Promise<number | null> {
  const flipped = await getDb()
    .update(projectSteps)
    .set({ status: "done", result: opts.result })
    .where(and(eq(projectSteps.id, opts.stepId), eq(projectSteps.status, "running")))
    // 一并取回 createdAt（= run 起步时刻）：导出收尾据此判断本次 run 期间内容有没有被改过，
    // 顺手带出来比事后再查一次省一趟往返。
    .returning({ id: projectSteps.id, createdAt: projectSteps.createdAt })
  if (flipped.length === 0) return null
  // 附录系统章节同步钩子（2026-08-09）：content 步产出带 sys-creds 键时,把系统章追加进库里
  // outline result——编辑器/审查/导出页读的是这份库存,不追加就只有 agent 图内 state 知道这
  // 章存在。本函数是 SSE 收尾与对账 Cron recover 路径唯一的共同入口,放这里两条路都生效
  // （无需在 reconcileStuckStep 里再补一遍）。失败只记日志、不挡结算与推进：宁可这次附录
  // 没同步上,也不能让已交付的正文结果卡在半收尾（与「失败必退、成功必交付」同一方向性）。
  if (opts.step === "content") {
    await syncCredentialsOutline(opts.projectId, opts.result).catch((e) =>
      console.error(`[credentials-chapter] outline 同步失败 project=${opts.projectId}:`, e))
  }
  return await settleAndAdvance({
    stepId: opts.stepId, projectId: opts.projectId, step: opts.step, result: opts.result,
    hold: opts.holdId ? { holdId: opts.holdId, heldAmount: opts.heldAmount } : null,
    runStartedAt: flipped[0]!.createdAt,
    billing: opts.billing,
  })
}

/** 按预扣幂等键 hold:<stepId> 找该步 hold（金额取正,见 credits.hold 的 -amount 口径）。 */
async function findHold(stepId: string): Promise<{ holdId: string; heldAmount: number } | null> {
  const [h] = await getDb()
    .select()
    .from(creditTransactions)
    .where(and(eq(creditTransactions.type, "hold"), eq(creditTransactions.idempotencyKey, `hold:${stepId}`)))
  return h ? { holdId: h.id, heldAmount: -h.amount } : null
}

/** 对账单个卡 running 行。判定次序（生死以 agent 为准,不按行龄盲杀）：
 *  - run 无 id：超龄判死（建 run 前就断了,无结果可救）;
 *  - succeeded 且结果可取 → 正常收尾交付（recovered）;结果不可取（超 24h 视界的存量 run）→ 判死退款;
 *  - failed / 查无 run → 判死退款;
 *  - running/queued → 活着（agent 侧心跳清道夫会把真孤儿翻成 failed,下轮对账收割）;
 *  - agent 不可达 → 只有超过 24h 才兜底判死,否则等下轮（宁可慢,不误杀）。 */
export async function reconcileStuckStep(
  row: { id: string; projectId: string; step: string; createdAt: Date; runId: string | null },
  getRun: GetRunFn,
  deps: { billing?: FinalizeBilling } = {},
  now: Date = new Date(),
): Promise<"recovered" | "failed" | "alive"> {
  const age = now.getTime() - row.createdAt.getTime()
  if (!row.runId) {
    if (age <= STUCK_STEP_MAX_AGE_MS) return "alive"
    await failStepAndRefund(row.id)
    return "failed"
  }
  let run: RunProbe
  try {
    run = await getRun(row.runId)
  } catch {
    if (age <= UNREACHABLE_KILL_AGE_MS) return "alive"
    await failStepAndRefund(row.id)
    return "failed"
  }
  if (run.status === "succeeded") {
    if (run.result != null) {
      const hold = await findHold(row.id)
      await finalizeStepSuccess({
        stepId: row.id, projectId: row.projectId, step: row.step as Step,
        result: run.result, holdId: hold?.holdId ?? null, heldAmount: hold?.heldAmount ?? 0,
        billing: deps.billing,
      })
      return "recovered" // 翻转即便被并发抢先,行也已了结——对调用方同义
    }
    await failStepAndRefund(row.id) // 成功但结果超视界不可取:无从交付,退款让用户重跑
    return "failed"
  }
  if (run.status === "failed" || run.status == null) {
    await failStepAndRefund(row.id)
    return "failed"
  }
  return "alive" // running/queued:信任 agent 清道夫,不按行龄杀
}

/** 撞 409 后的惰性自愈入口（routes/projects.ts acquireStepSlot 调用）：
 *  cleared=死行已清（可重试插占位行）;recovered=该步刚被成功收尾（调用方应 409 提示已完成,
 *  绝不能重插重跑——那是对已交付结果的重复计费）;alive=如实 409。
 *  running 行已消失时必须再看该步最新行:并发收尾若刚把它翻成 done,按 recovered 处理——
 *  当 cleared 放行重插会对刚交付的结果重建 run 重复计费（评审确认的并发窗口）。 */
export async function healStuckStep(
  projectId: string,
  step: string,
  getRun: GetRunFn,
  now: Date = new Date(),
): Promise<"cleared" | "recovered" | "alive"> {
  const [row] = await getDb()
    .select()
    .from(projectSteps)
    .where(and(eq(projectSteps.projectId, projectId), eq(projectSteps.step, step), eq(projectSteps.status, "running")))
  if (!row) {
    const [latest] = await getDb()
      .select({ status: projectSteps.status })
      .from(projectSteps)
      .where(and(eq(projectSteps.projectId, projectId), eq(projectSteps.step, step)))
      .orderBy(desc(projectSteps.createdAt))
      .limit(1)
    return latest?.status === "done" ? "recovered" : "cleared"
  }
  const outcome = await reconcileStuckStep(row, getRun, {}, now)
  return outcome === "failed" ? "cleared" : outcome === "recovered" ? "recovered" : "alive"
}

/** 对账 Cron 体：①扫超龄 running 行逐个对账（旧机制纯惰性:用户不点重试就永远卡着,发版前
 *  还得手工 failStepAndRefund——这里变成 5 分钟一轮自动对账）;②修复半收尾行:翻转 done 后、
 *  结算/推进前崩溃（发版/DB 抖动）留下的「done 且 costPoints 空」——不补齐则 currentStep
 *  永不推进（下一步恒 409）且 hold 冻结,还开着「重跑同步重复计费」的口子。 */
export async function sweepStuckSteps(
  getRun: GetRunFn,
  now: Date = new Date(),
): Promise<{ recovered: number; failed: number; alive: number; repaired: number }> {
  const cutoff = new Date(now.getTime() - STUCK_STEP_MAX_AGE_MS)
  const rows = await getDb()
    .select()
    .from(projectSteps)
    .where(and(eq(projectSteps.status, "running"), lt(projectSteps.createdAt, cutoff)))
  const counts = { recovered: 0, failed: 0, alive: 0, repaired: 0 }
  for (const row of rows) {
    try {
      counts[await reconcileStuckStep(row, getRun, {}, now)] += 1
    } catch (e) {
      console.error(`[cron:stuck-steps] reconcile ${row.id} 失败:`, e) // 单行失败不挡后续行
    }
  }
  // 半收尾修复：flip done 之后（结算/计费/推进任一段前）崩溃的行。判定不能用 costPoints
  // （NOT NULL DEFAULT 0,与合法 0 费不可分）,以账本与流程状态为准:
  //   R1: done 行仍挂着未了结的 hold（无 settle/release 行）→ 重放 settleAndAdvance（幂等）;
  //   R2: done 行已了结但 currentStep 仍停在该步 → 补条件推进（幂等,与在途收尾并发无害）。
  // 只扫最近 24h 的 done 行:楔子由 5 分钟一轮的本 Cron 及时修,无需全表回溯。
  const dayAgo = new Date(now.getTime() - 24 * 3600_000)
  const recentDone = await getDb()
    .select()
    .from(projectSteps)
    .where(and(eq(projectSteps.status, "done"), gt(projectSteps.createdAt, dayAgo)))
  for (const row of recentDone) {
    try {
      const hold = await findHold(row.id)
      if (hold && !(await hasSettlement(hold.holdId))) {
        await settleAndAdvance({
          stepId: row.id, projectId: row.projectId, step: row.step as Step, result: row.result, hold,
          runStartedAt: row.createdAt,
        })
        counts.repaired += 1
        continue
      }
      const [proj] = await getDb()
        .select({ currentStep: bidProjects.currentStep, kind: bidProjects.kind })
        .from(bidProjects)
        .where(eq(bidProjects.id, row.projectId))
      // 与 advanceGuard 同集：export 可从 review（跳过体检）/present（跳过述标）两处推进——
    // 这里漏一个，进程在「行已 done、项目未推进」之间死掉的窗口就再也修不回来（永远 running）
    if (proj && (proj.currentStep === row.step
      || (row.step === "export" && ["review", "present"].includes(proj.currentStep)))) {
        const next = nextStepFor(row.step as Step, proj.kind ?? "bid")
        await getDb()
          .update(bidProjects)
          .set({ currentStep: next ?? "done", status: next ? "running" : "done" })
          .where(and(eq(bidProjects.id, row.projectId), advanceGuard(row.step as Step)))
        counts.repaired += 1
      }
    } catch (e) {
      console.error(`[cron:stuck-steps] repair ${row.id} 失败:`, e)
    }
  }
  return counts
}

/** 该 hold 是否已有了结行（settle/release,ref=holdId,部分唯一索引保证至多一条）。 */
async function hasSettlement(holdId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: creditTransactions.id })
    .from(creditTransactions)
    .where(and(eq(creditTransactions.ref, holdId), inArray(creditTransactions.type, ["settle", "release"])))
    .limit(1)
  return rows.length > 0
}

/** 已成功完成过几次正文。

 *  给 agent 当"第几次生成"的线索：**重试时它不变**（接得上刚写了一半的检查点），
 *  **重新生成时它 +1**（换一条干净的线，不会把上一份成稿当成新结果交回来）。
 *  比布尔开关稳：布尔要靠"上一条是不是 done"推意图，而一次失败的重新生成之后，
 *  那个推断会翻转，重试就接到上一次**已完成**的检查点上去了（2026-08-08 审查提出）。 */
export async function contentGeneration(projectId: string): Promise<number> {
  const rows = await getDb()
    .select({ id: projectSteps.id })
    .from(projectSteps)
    .where(and(eq(projectSteps.projectId, projectId), eq(projectSteps.step, "content"),
               eq(projectSteps.status, "done")))
  return rows.length
}

