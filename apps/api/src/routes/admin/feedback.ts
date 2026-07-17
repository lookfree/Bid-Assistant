import { Hono } from "hono"
import { z } from "zod"
import { eq, desc, sql, getTableColumns } from "drizzle-orm"
import { requirePermission } from "../../middleware/admin-auth"
import { parsePagination, pagedBody, pagedResult } from "../../lib/pagination"
import { getDb } from "../../db/client"
import { feedback, users, FEEDBACK_STATUSES, type FeedbackStatus } from "../../db/schema"
import { isUuid } from "../../lib/uuid"
import { writeAudit } from "../../services/audit"
import type { AdminUser } from "../../db/schema"

// 反馈/投诉处理页（spec326）：读=feedback.read；处理（改状态+回复）=feedback.write。
// ops/support 两角色都有这两个权限（客服处理工单是本职），finance 不加——见 rbac.ts。
export const feedbackRouter = new Hono<{ Variables: { admin: AdminUser } }>()

feedbackRouter.get("/", requirePermission("feedback.read"), async (c) => {
  let pg
  try {
    pg = parsePagination(c.req.query())
  } catch {
    return c.json({ error: "invalid_pagination" }, 400)
  }
  const status = c.req.query("status")
  if (status && !(FEEDBACK_STATUSES as readonly string[]).includes(status)) return c.json({ error: "invalid_input" }, 400)
  const where = status ? eq(feedback.status, status as FeedbackStatus) : undefined
  const db = getDb()
  const result = await pagedResult(
    db
      .select({ ...getTableColumns(feedback), nickname: users.nickname })
      .from(feedback)
      .leftJoin(users, eq(users.id, feedback.userId))
      .where(where)
      .orderBy(desc(feedback.createdAt))
      .limit(pg.pageSize)
      .offset(pg.offset),
    db.select({ n: sql<number>`count(*)` }).from(feedback).where(where),
  )
  return c.json(pagedBody(pg, result))
})

const patchSchema = z.object({
  status: z.enum(["processing", "resolved"]),
  reply: z.string().max(2000).optional(),
})

feedbackRouter.patch("/:id", requirePermission("feedback.write"), async (c) => {
  const id = c.req.param("id")
  if (!isUuid(id)) return c.json({ error: "not_found" }, 404) // 非 uuid 与不存在同语义，避免 PG 22P02 500
  const parsed = patchSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
  const db = getDb()
  const [before] = await db.select().from(feedback).where(eq(feedback.id, id))
  if (!before) return c.json({ error: "not_found" }, 404)
  const [row] = await db
    .update(feedback)
    .set({ status: parsed.data.status, reply: parsed.data.reply, handledBy: c.var.admin.username, handledAt: new Date() })
    .where(eq(feedback.id, id))
    .returning()
  await writeAudit({
    operator: c.var.admin.username,
    action: "feedback.handle",
    target: `feedback:${id}`,
    before: { status: before.status },
    after: { status: parsed.data.status, reply: parsed.data.reply },
  })
  return c.json(row)
})
