import { Hono } from "hono"
import { z } from "zod"
import { eq, and, desc, inArray, isNull } from "drizzle-orm"
import { getDb } from "../db/client"
import { libraryItems, projectFiles, LIBRARY_CATEGORIES, type LibraryItem } from "../db/schema"
import type { User } from "../db/schema"
import { authMiddleware } from "../middleware/auth"
import { getUserId } from "../lib/auth-user"
import { isUuid } from "../lib/uuid"
import { deleteObject } from "../storage/s3"
import { backfillAttachmentOcr } from "../services/library-ocr"
import { backfillAttachmentText, ATTACHMENT_TEXT_MAX_CHARS } from "../services/library-text"
import type { parseAttachmentText } from "../services/agent-client"
import * as client from "../services/agent-client"

// CRUD 钩子可注入（测试 mock agent-client，断言被调 + best-effort 不阻塞响应），默认真实 agent-client。
export type LibraryDeps = {
  ragIndex: typeof client.ragIndex
  ragDelete: typeof client.ragDelete
}

// 条目 body 校验：POST 必填 category/title；PUT 契约为「缺键=不改，null=清空」，
// 故可清空字段一律 .nullable().optional()（title 不可 null，category 枚举可选但不可 null）。
const fieldSchema = z.object({ label: z.string(), value: z.string() })
// sourceFileId：页图附件指向其来源 PDF 的 fileId（spec 2026-08-08）；zod 默认 strip 未声明键，
// 漏写会导致该字段静默丢失（保存后 hasDerivedPages 恒 false，「转为图片」按钮重现、PDF 被重复列出）。
// ocrText：图片附件的前置 OCR 识别文字（spec 2026-08-09 基建）；同 sourceFileId 的教训，
// 漏写会导致该字段静默丢失（回填写回后再保存一次就把已识别的文字冲掉）。
// text：文档附件（docx/pdf/xlsx…）解析出的正文（spec 2026-08-11），后台回填、进 RAG 索引；
// 同上教训——漏写这一键，解析好的正文会在用户下次保存时被剥掉，条目又变回「只看得见标题」。
const attachmentSchema = z.object({
  fileId: z.string().uuid(),
  name: z.string(),
  sourceFileId: z.string().uuid().optional(),
  ocrText: z.string().max(500).optional(),
  text: z.string().max(ATTACHMENT_TEXT_MAX_CHARS).optional(),
})
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

// 服务端自有的附件字段：由后台管线（library-text 解析正文 / library-ocr 识别图片文字）写回，
// **前端从不产出、也不该回传**。出参一律剔掉、入参一律按 fileId 从库里补回——见 stripServerFields
// 与 keepServerFields。text 尤其大（单附件上限 50k 字），留在出参里前端会缓存下来、下次保存再传回，
// 等于把负担从读挪到写（2026-08-11 审查实测指出）。
const SERVER_OWNED_ATTACHMENT_FIELDS = ["text", "ocrText"] as const

/** 出参剔掉服务端自有字段（GET 列表与 POST/PUT 响应共用——只剔这几个键，其余原样）。 */
function stripServerFields<T extends { attachments: LibraryItem["attachments"] }>(item: T): T {
  if (!item.attachments?.length) return item
  return {
    ...item,
    attachments: item.attachments.map((a) => {
      const copy = { ...a }
      for (const k of SERVER_OWNED_ATTACHMENT_FIELDS) delete (copy as Record<string, unknown>)[k]
      return copy
    }),
  }
}

/** 写入时按 fileId 把服务端自有字段补回：前端拿不到它们，原样回传就会把已解析的正文与
 *  已识别的证照文字一起抹掉（后者会让附录图的说明退回只剩文件名）。
 *  按 fileId 对齐——用户换附件顺序、删掉某个附件都不影响其余附件。 */
function keepServerFields(
  incoming: LibraryItem["attachments"],
  existing: LibraryItem["attachments"],
): LibraryItem["attachments"] {
  if (!incoming?.length) return incoming
  const byId = new Map((existing ?? []).map((a) => [a.fileId, a]))
  return incoming.map((a) => {
    const prev = byId.get(a.fileId)
    if (!prev) return a
    const merged = { ...a }
    for (const k of SERVER_OWNED_ATTACHMENT_FIELDS) {
      if (merged[k] === undefined && prev[k] !== undefined) merged[k] = prev[k]
    }
    return merged
  })
}

// 附件正文由 services/library-text 后台解析后写回 attachments[].text（扫描版 PDF 走 OCR），
// spec 2026-08-11：在此之前系统只看得见附件的标题，用户上传的 docx/pdf 内容完全不进检索。
// 每份附件带上文件名再拼正文——文件名本身就是强检索信号（「零信任统一身份认证技术方案.docx」），
// 且切块后每块都还认得出自己来自哪份附件。没有附件正文时输出与改前逐字节一致。
function indexText(item: Pick<LibraryItem, "title" | "meta" | "fields" | "body" | "attachments">): string {
  const parts = [item.title]
  if (item.meta) parts.push(item.meta)
  if (item.fields?.length) parts.push(item.fields.map((f) => `${f.label}：${f.value}`).join("；"))
  if (item.body) parts.push(item.body)
  for (const a of item.attachments ?? []) if (a.text) parts.push(`${a.name}\n${a.text}`)
  return parts.join("\n")
}

// 建/改条目后 best-effort 建索引（重建该条向量）：agent 不可达/抛错只告警，绝不影响 CRUD 响应。
async function bestEffortIndex(
  ragIndex: LibraryDeps["ragIndex"],
  userId: string,
  item: Pick<LibraryItem, "id" | "title" | "meta" | "fields" | "body" | "attachments">,
): Promise<void> {
  try {
    await ragIndex({ userId, sourceId: item.id, title: item.title, text: indexText(item) })
  } catch (e) {
    console.warn(`library rag 索引失败 itemId=${item.id}:`, e)
  }
}

/**
 * 条目保存后的附件后台加工（导出供测试直调；路由层 fire-and-forget 调用，绝不阻塞 CRUD）。
 *
 * **串行**跑 OCR（图片附件的 ocrText）与正文解析（文档附件的 text）：两者都整列覆写
 * attachments 且各带一道乐观锁，并行跑就是后写的那个撞上「列已变」而静默丢弃自己的成果。
 *
 * 解析完成才重建索引：解析是分钟量级的慢活（扫描版 PDF 还要逐页 OCR），保存那一刻建的索引里
 * 没有附件正文——不在这里补一次，用户就得再保存一遍才被检索到。没解析出新正文则不重建
 * （省一次 embed）。全程不抛：调用方是 fire-and-forget，没人接得住异常。
 */
export async function enrichAttachments(
  ragIndex: LibraryDeps["ragIndex"],
  userId: string,
  itemId: string,
  parse?: typeof parseAttachmentText,
): Promise<void> {
  try {
    await backfillAttachmentOcr(itemId, userId)
    if (!(await backfillAttachmentText(itemId, userId, parse))) return
    const [row] = await getDb()
      .select()
      .from(libraryItems)
      .where(and(eq(libraryItems.id, itemId), eq(libraryItems.userId, userId)))
    if (row) await bestEffortIndex(ragIndex, userId, row)
  } catch (e) {
    console.warn(`library 附件后台加工失败 itemId=${itemId}:`, e)
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

  // 当前用户全部条目（个人资料量小，不分页）。
  // **附件正文不随列表返回**：attachments[].text 是后台解析出的全文（单附件上限 50k 字、
  // 单条目 100k 字），而本接口是资料库页与正文页「从资料库插入」的共用数据源、在投标热路径上——
  // 带上它，一个重附件用户每次开页就要拉几 MB（同 content 步 ?slim=1 那类坑：SQL 层不选大列，
  // 实测 28ms vs 2788ms）。正文只有后台解析与建索引用得着，前端一处都不读。
  // 保存时不带这些字段也不会丢：write 路径按 fileId 从库里补回（见 keepServerFields）。
  r.get("/", async (c) => {
    const items = await getDb()
      .select()
      .from(libraryItems)
      .where(eq(libraryItems.userId, getUserId(c)))
      .orderBy(desc(libraryItems.createdAt))
    return c.json({ items: items.map(stripServerFields) })
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
    void bestEffortIndex(ragIndex, userId, row) // fire-and-forget：agent 慢/挂也不阻塞响应（30s 超时不拖住用户）
    void enrichAttachments(ragIndex, userId, row.id) // fire-and-forget：附件 OCR + 正文解析，完事再重建索引
    return c.json(stripServerFields(row), 201)
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
    // 属主隔离：where 带 userId，非本人的条目等同不存在 → 404。
    // 带附件时是「读快照 → 合并服务端自有字段 → 写」的读改写：**必须带乐观锁**，否则窗口里
    // 后台解析/OCR 刚提交的成果会被这次保存覆盖掉，用户要等它重跑几分钟才恢复可检索
    // （两个 backfill 自己都用 `eq(attachments, snapshot)` 守着，这里漏了就是单向的破坏）。
    // 撞锁说明后台刚写完，重读一次再合并即可——最多一次，仍撞就让它按普通更新落地。
    const writeOnce = async (guard: boolean) => {
      if (patch.attachments === undefined || patch.attachments === null) {
        return getDb().update(libraryItems).set({ ...patch, updatedAt: new Date() })
          .where(and(eq(libraryItems.id, id), eq(libraryItems.userId, userId))).returning()
      }
      const [before] = await getDb()
        .select({ attachments: libraryItems.attachments })
        .from(libraryItems)
        .where(and(eq(libraryItems.id, id), eq(libraryItems.userId, userId)))
        .limit(1)
      if (!before) return []
      const merged = keepServerFields(patch.attachments, before.attachments)
      const mine = and(eq(libraryItems.id, id), eq(libraryItems.userId, userId))
      // 快照为 null 时用 IS NULL 比对——jsonb 列的 `= NULL` 恒不成立，会让守卫永远撞锁。
      const snapshot = before.attachments === null
        ? isNull(libraryItems.attachments)
        : eq(libraryItems.attachments, before.attachments)
      const where = guard ? and(mine, snapshot) : mine
      return getDb().update(libraryItems)
        .set({ ...patch, attachments: merged, updatedAt: new Date() }).where(where).returning()
    }
    let [row] = await writeOnce(true)
    if (!row) [row] = await writeOnce(false)
    if (!row) return c.json({ error: "not_found" }, 404)
    void bestEffortIndex(ragIndex, userId, row) // fire-and-forget 重建该条向量：agent 慢/挂不阻塞响应
    void enrichAttachments(ragIndex, userId, row.id) // fire-and-forget：附件 OCR + 正文解析，完事再重建索引
    return c.json(stripServerFields(row))
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
    void bestEffortDelete(ragDelete, userId, id) // fire-and-forget 删索引：agent 慢/挂不阻塞响应
    return c.json({ ok: true })
  })

  // 手动重建索引（spec316）：属主隔离，本人全部条目逐条 fire-and-forget 建索引，供资料库页后续按钮预留。
  // 不逐条 await——否则 agent 挂时 N×30s 拖死运营；派发后即返回 {dispatched:n}（后台异步跑完）。
  r.post("/reindex", async (c) => {
    const userId = getUserId(c)
    const items = await getDb().select().from(libraryItems).where(eq(libraryItems.userId, userId))
    for (const item of items) void bestEffortIndex(ragIndex, userId, item)
    return c.json({ dispatched: items.length })
  })

  return r
}
