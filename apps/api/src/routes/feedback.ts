import { Hono } from "hono"
import { z } from "zod"
import { eq, and, gte, desc, sql } from "drizzle-orm"
import { getDb } from "../db/client"
import { feedback, FEEDBACK_TYPES } from "../db/schema"
import type { User } from "../db/schema"
import { authMiddleware } from "../middleware/auth"
import { getUserId } from "../lib/auth-user"

// 反馈/投诉入口（spec326）：money-blind，免费、不扣积分、与 credits 无任何交互。
const DAILY_LIMIT = 20

const bodySchema = z.object({
  type: z.enum(FEEDBACK_TYPES),
  content: z.string().min(1).max(2000),
  contact: z.string().max(100).optional(),
  projectId: z.string().uuid().optional(),
})

// 日限防刷：当日（归零到当天 00:00）本人已提交数达上限则拒收，非计费路径。
async function overDailyLimit(userId: string): Promise<boolean> {
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)` })
    .from(feedback)
    .where(and(eq(feedback.userId, userId), gte(feedback.createdAt, todayStart)))
  return Number(row?.n ?? 0) >= DAILY_LIMIT
}

export function feedbackRoutes() {
  const r = new Hono<{ Variables: { user: User } }>()
  r.use("*", authMiddleware)

  r.post("/", async (c) => {
    const parsed = bodySchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
    const userId = getUserId(c)
    if (await overDailyLimit(userId)) return c.json({ error: "too_many_feedback" }, 429)
    const [row] = await getDb()
      .insert(feedback)
      .values({ userId, ...parsed.data })
      .returning()
    if (!row) return c.json({ error: "insert_failed" }, 500)
    return c.json(row, 201)
  })

  // 本人列表（含 admin 处理结果，供用户查看回复）；属主隔离：where 带 userId。
  r.get("/", async (c) => {
    const items = await getDb()
      .select()
      .from(feedback)
      .where(eq(feedback.userId, getUserId(c)))
      .orderBy(desc(feedback.createdAt))
      .limit(50)
    return c.json({ items })
  })

  return r
}
