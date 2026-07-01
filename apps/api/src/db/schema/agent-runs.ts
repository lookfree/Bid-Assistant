import { pgTable, uuid, text, jsonb, integer, index } from "drizzle-orm/pg-core"
import { id, createdAt } from "./columns"
import { users } from "./users"

// App 侧每个 agent run 一行；与 agent.* 观测表靠 runId 关联（§4.7）。
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentType: text("agent_type").notNull(), // "bidding_agent"
    runId: text("run_id").notNull().unique(), // Agent Service 返回的 run_id
    threadId: text("thread_id").notNull(), // 会话键（一本标书）
    status: text("status").notNull().default("running"), // running/done/failed
    costPoints: integer("cost_points").notNull().default(0), // 计费 stub 记账
    result: jsonb("result"), // 该 run 结构化结果（如 ReadResult）
    createdAt: createdAt(),
  },
  (t) => ({ userIdx: index("agent_runs_user_idx").on(t.userId) }),
)
