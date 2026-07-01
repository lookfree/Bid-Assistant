import { pgSchema, uuid, integer, timestamp } from "drizzle-orm/pg-core"

// agent.* 由 Agent 侧（spec102）建表/迁移；App 仅只读映射用于 settle 汇总，列名/类型对齐 spec102。
// 特意放在 db/schema/ 之外：drizzle.config 扫 schema/*，放这里避免 drizzle-kit 误把 agent.* 纳入迁移。
const agentSchema = pgSchema("agent")

export const agentTokenUsage = agentSchema.table("agent_token_usage", {
  runId: uuid("run_id").notNull(), // 关联 Agent Service run_id
  totalTokens: integer("total_tokens").notNull().default(0), // 对齐 spec102（int）
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  // 只声明 settle 汇总用到的列；其余（input/output/cached 等）按需补，命名对齐 spec102。
})
