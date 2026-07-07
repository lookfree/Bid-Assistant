import { pgTable, uuid, jsonb, integer, index } from "drizzle-orm/pg-core"
import { id, createdAt } from "./columns"
import { users } from "./users"

// 标书查重审计（spec315b）：每次 POST /api/dedupe 成功交付后落一行——
// 花了 100 分的操作要可追溯（params=请求参数、result=agent 结果原样、cost=实际计费额）。
export const dedupeRuns = pgTable(
  "dedupe_runs",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    params: jsonb("params").notNull(), // {fileKeys, tenderKey?, dims, strategy}
    result: jsonb("result").notNull(), // agent /dedupe 响应（snake_case 原样）
    cost: integer("cost").notNull().default(0), // 实际计费积分
    createdAt: createdAt(),
  },
  (t) => ({ userIdx: index("dedupe_runs_user_idx").on(t.userId) }),
)
