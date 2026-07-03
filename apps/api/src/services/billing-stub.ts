import { getDb } from "../db/client"
import { agentTokenUsage } from "../db/observability" // spec102 的 agent.agent_token_usage（只读汇总）
import { eq, sql } from "drizzle-orm"

// 每步消耗积分（Phase 3 接真账本）。与 agent 节点序一致的六步档位（spec207）。
export const STEP_COST: Record<string, number> = {
  read: 10, outline: 8, content: 30, review: 8, present: 12, export: 2,
}

export async function preDeduct(step: string): Promise<{ ok: boolean; hold: number }> {
  // TODO(Phase3): 校验余额并冻结。stub：放行，返回应扣额度。
  return { ok: true, hold: STEP_COST[step] ?? 0 }
}

export async function settle(runId: string, hold: number): Promise<number> {
  // 真去汇总该 run 实际 token 用量（消费路径打通）；积分换算 Phase 3 接真账本，此处 stub 按 hold 结算。
  const [row] = await getDb()
    .select({ total: sql<number>`coalesce(sum(${agentTokenUsage.totalTokens}), 0)` })
    .from(agentTokenUsage)
    .where(eq(agentTokenUsage.runId, runId))
  void row // 可据 row.total 做计量日志；stub 返回 hold
  return hold
}
