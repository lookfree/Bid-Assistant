import { Hono } from "hono"
import { z } from "zod"
import { eq, and, desc, inArray } from "drizzle-orm"
import { getDb } from "../db/client"
import { libraryItems, projectFiles, LIBRARY_CATEGORIES, type LibraryItem } from "../db/schema"
import type { User } from "../db/schema"
import { authMiddleware } from "../middleware/auth"
import { getUserId } from "../lib/auth-user"
import { isUuid } from "../lib/uuid"
import { deleteObject } from "../storage/s3"
import * as client from "../services/agent-client"

// CRUD 钩子可注入（测试 mock agent-client，断言被调 + best-effort 不阻塞响应），默认真实 agent-client。
export type LibraryDeps = {
  ragIndex: typeof client.ragIndex
  ragDelete: typeof client.ragDelete
}

// 条目 body 校验：POST 必填 category/title；PUT 契约为「缺键=不改，null=清空」，
// 故可清空字段一律 .nullable().optional()（title 不可 null，category 枚举可选但不可 null）。
const fieldSchema = z.object({ label: z.string(), value: z.string() })
const attachmentSchema = z.object({ fileId: z.string().uuid(), name: z.string() })
const itemSchema = z.object({
  category: z.enum(LIBRARY_CATEGORIES),
  title: z.string().min(1),
  meta: z.string().nullable().optional(),
  fields: z.array(fieldSchema).nullable().optional(),
  expiry: z.string().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  attachments: z.array(attachmentSchema).nullable().optional(),
  body: z.string().nullable().optional(),
})
const updateSchema = itemSchema.partial()

// attachments 引用校验：非空时所有 fileId 必须是本人 project_files 已有行，
// 否则可挂他人/不存在文件（越权引用 + 删除清理时误删）。
async function attachmentsValid(
  atts: { fileId: string }[] | null | undefined,
  userId: string,
): Promise<boolean> {
  if (!atts || atts.length === 0) return true
  const ids = [...new Set(atts.map((a) => a.fileId))]
  const rows = await getDb()
    .select({ id: projectFiles.id })
    .from(projectFiles)
    .where(and(inArray(projectFiles.id, ids), eq(projectFiles.userId, userId)))
  return rows.length === ids.length
}

// 删条目后 best-effort 清附件：删 MinIO 对象 + project_files 行。
// 附件与条目当前 1:1（上传即挂条目），失败只告警不影响删除结果——孤儿留待后续 GC spec 统一回收。
async function cleanupAttachments(atts: { fileId: string }[] | null, userId: string): Promise<void> {
  for (const a of atts ?? []) {
    try {
      const [f] = await getDb()
        .select()
        .from(projectFiles)
        .where(and(eq(projectFiles.id, a.fileId), eq(projectFiles.userId, userId)))
      if (!f) continue
      await deleteObject(f.key)
      await getDb().delete(projectFiles).where(eq(projectFiles.id, f.id))
    } catch (e) {
      console.warn(`library 附件清理失败 fileId=${a.fileId}:`, e)
    }
  }
}

// 条目可检索文本（spec316）：title + meta + 结构化字段 + 正文；附件不入（只索引文本字段）。
function indexText(item: Pick<LibraryItem, "title" | "meta" | "fields" | "body">): string {
  const parts = [item.title]
  if (item.meta) parts.push(item.meta)
  if (item.fields?.length) parts.push(item.fields.map((f) => `${f.label}：${f.value}`).join("；"))
  if (item.body) parts.push(item.body)
  return parts.join("\n")
}

// 建/改条目后 best-effort 建索引（重建该条向量）：agent 不可达/抛错只告警，绝不影响 CRUD 响应。
async function bestEffortIndex(
  ragIndex: LibraryDeps["ragIndex"],
  userId: string,
  item: Pick<LibraryItem, "id" | "title" | "meta" | "fields" | "body">,
): Promise<void> {
  try {
    await ragIndex({ userId, sourceId: item.id, title: item.title, text: indexText(item) })
  } catch (e) {
    console.warn(`library rag 索引失败 itemId=${item.id}:`, e)
  }
}

// 删条目后 best-effort 删索引：同上，失败不影响删除结果。
async function bestEffortDelete(ragDelete: LibraryDeps["ragDelete"], userId: string, id: string): Promise<void> {
  try {
    await ragDelete({ userId, sourceType: "library", sourceId: id })
  } catch (e) {
    console.warn(`library rag 删索引失败 itemId=${id}:`, e)
  }
}

export function libraryRoutes(deps: Partial<LibraryDeps> = {}) {
  const ragIndex = deps.ragIndex ?? client.ragIndex
  const ragDelete = deps.ragDelete ?? client.ragDelete

  const r = new Hono<{ Variables: { user: User } }>()
  r.use("*", authMiddleware) // 资料属本人，需登录

  // 当前用户全部条目（个人资料量小，不分页）
  r.get("/", async (c) => {
    const items = await getDb()
      .select()
      .from(libraryItems)
      .where(eq(libraryItems.userId, getUserId(c)))
      .orderBy(desc(libraryItems.createdAt))
    return c.json({ items })
  })

  r.post("/", async (c) => {
    const parsed = itemSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
    const userId = getUserId(c)
    if (!(await attachmentsValid(parsed.data.attachments, userId)))
      return c.json({ error: "invalid_attachments" }, 400)
    const [row] = await getDb()
      .insert(libraryItems)
      .values({ userId, ...parsed.data })
      .returning()
    if (!row) return c.json({ error: "insert_failed" }, 500)
    await bestEffortIndex(ragIndex, userId, row) // best-effort，失败不影响响应
    return c.json(row, 201)
  })

  r.put("/:id", async (c) => {
    const id = c.req.param("id")
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404)
    const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400)
    const userId = getUserId(c)
    if (!(await attachmentsValid(parsed.data.attachments, userId)))
      return c.json({ error: "invalid_attachments" }, 400)
    // PUT 语义：缺键（undefined）=跳过不改；显式 null=清空该列。逐键过滤 undefined 落 patch。
    const patch = Object.fromEntries(
      Object.entries(parsed.data).filter(([, v]) => v !== undefined),
    ) as Partial<typeof libraryItems.$inferInsert>
    // 属主隔离：where 带 userId，非本人的条目等同不存在 → 404
    const [row] = await getDb()
      .update(libraryItems)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(libraryItems.id, id), eq(libraryItems.userId, userId)))
      .returning()
    if (!row) return c.json({ error: "not_found" }, 404)
    await bestEffortIndex(ragIndex, userId, row) // best-effort 重建该条向量，失败不影响响应
    return c.json(row)
  })

  r.delete("/:id", async (c) => {
    const id = c.req.param("id")
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404)
    const userId = getUserId(c)
    const [row] = await getDb()
      .delete(libraryItems)
      .where(and(eq(libraryItems.id, id), eq(libraryItems.userId, userId)))
      .returning()
    if (!row) return c.json({ error: "not_found" }, 404)
    await cleanupAttachments(row.attachments, userId) // best-effort，失败不影响结果
    await bestEffortDelete(ragDelete, userId, id) // best-effort 删索引，失败不影响结果
    return c.json({ ok: true })
  })

  // 手动重建索引（spec316）：属主隔离，遍历本人全部条目逐条 best-effort 建索引，供资料库页后续按钮预留。
  r.post("/reindex", async (c) => {
    const userId = getUserId(c)
    const items = await getDb().select().from(libraryItems).where(eq(libraryItems.userId, userId))
    for (const item of items) await bestEffortIndex(ragIndex, userId, item)
    return c.json({ reindexed: items.length })
  })

  return r
}
