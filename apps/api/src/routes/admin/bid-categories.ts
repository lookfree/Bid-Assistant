import { Hono } from "hono"
import { desc, sql } from "drizzle-orm"
import { getDb } from "../../db/client"
import { bidCategoryCorrections, bidProjects } from "../../db/schema"
import { parsePagination, pagedBody, pagedResult } from "../../lib/pagination"
import type { AdminUser } from "../../db/schema"

// 分类纠偏样本（spec334）：**判定质量的唯一反馈回路**。没有这一页，同一个判错会被一百个用户
// 各纠一次，而我们一次都不知道。只读——纠偏是 C 端用户的动作，运营在这里看趋势、据此改分类提示词。
export const bidCategoriesRouter = new Hono<{ Variables: { admin: AdminUser } }>()

/** 明细：最近的改判记录（判定 → 确认），带项目名便于回溯是哪一本标。 */
bidCategoriesRouter.get("/corrections", async (c) => {
  let pg
  try {
    pg = parsePagination(c.req.query())
  } catch {
    return c.json({ error: "invalid_pagination" }, 400)
  }
  const db = getDb()
  const rowsQuery = db
    .select({
      id: bidCategoryCorrections.id,
      projectId: bidCategoryCorrections.projectId,
      projectName: bidProjects.name,
      detected: bidCategoryCorrections.detected,
      confirmed: bidCategoryCorrections.confirmed,
      confidence: bidCategoryCorrections.confidence,
      createdAt: bidCategoryCorrections.createdAt,
    })
    .from(bidCategoryCorrections)
    .leftJoin(bidProjects, sql`${bidProjects.id} = ${bidCategoryCorrections.projectId}`)
    .orderBy(desc(bidCategoryCorrections.createdAt))
    .limit(pg.pageSize)
    .offset((pg.page - 1) * pg.pageSize)
  // pagedResult 并发跑 rows + count；串行两次往返在远程 PG 上白白翻倍延迟（其余 admin 路由同法）
  const countQuery = db.select({ n: sql<number>`count(*)::int` }).from(bidCategoryCorrections)
  return c.json(pagedBody(pg, await pagedResult(rowsQuery, countQuery)))
})

/** 聚合：按「判错方向」计数（判成 A 实为 B），一眼看出分类提示词在哪个方向上系统性偏。
 *  只比主类别——次类别是补充，主类别错才是真的把标书结构带偏。 */
bidCategoriesRouter.get("/corrections/summary", async (c) => {
  const rows = await getDb()
    .select({
      detected: sql<string>`${bidCategoryCorrections.detected} ->> 0`,
      confirmed: sql<string>`${bidCategoryCorrections.confirmed} ->> 0`,
      count: sql<number>`count(*)::int`,
    })
    .from(bidCategoryCorrections)
    .groupBy(sql`${bidCategoryCorrections.detected} ->> 0`, sql`${bidCategoryCorrections.confirmed} ->> 0`)
    .orderBy(desc(sql`count(*)`))
  return c.json({ items: rows })
})
