import { and, eq, inArray } from "drizzle-orm"
import { getDb } from "../db/client"
import { libraryItems, projectFiles } from "../db/schema"
import { sliceAtCodePoint } from "../lib/text"
import { parseAttachmentText } from "./agent-client"

// 只解析文档类扩展（与 agent parsing/parsers._DISPATCH 支持的类型同口径）。
// 图片附件另有前置 OCR（services/library-ocr 的 ocrText），不在这里重复识别。
const DOC_EXTS = new Set(["docx", "doc", "pdf", "xlsx", "xls"])

/** 单附件正文上限（字符）。也是 routes/library.ts zod attachmentSchema.text 的上限——
 *  两处**必须同一个常量**：写回时不钳制的话，超限的 text 会让这个条目从此每次保存都撞 zod 400，
 *  被锁死在无法保存的状态（ocrText max(500) 踩过的同一课，见 services/library-ocr.ts）。
 *  50k 字 ≈ 一份技术方案的量级，够正文生成检索到实质内容。 */
export const ATTACHMENT_TEXT_MAX_CHARS = 50_000

/** 单条目所有附件正文合计上限（字符）。RAG 的检索单元是**整条条目**（rag/index 按 source_id
 *  整条切块），几十万字的附件正文会把 title/meta/正文这些真正的标识信号稀释掉，一次 index
 *  还要 embed 上千块。超预算的附件按顺序跳过（有日志），不是报错。 */
export const ITEM_TEXT_BUDGET_CHARS = 100_000

/** 解析前的体积闸（字节）。FILE_MAX_SIZE_MB 允许到 500MB（招标文件正本就有这么大），但资料库
 *  附件是证书/方案/介绍这类；再大只会把 agent 的解析线程按分钟计地占住。 */
export const PARSE_MAX_BYTES = 30 * 1024 * 1024

type ParseFn = typeof parseAttachmentText
type Attachment = { fileId: string; name: string; sourceFileId?: string; ocrText?: string; text?: string }
type FileRow = { id: string; key: string; size: number }

function extOf(key: string): string {
  return key.split(".").pop()?.toLowerCase() ?? ""
}

/** 单附件解析：拿到正文（含扫描页 OCR，agent 侧做）。失败/无文字一律返回空串——
 *  失败是这一个附件的事，不该拖累同条目里的其它附件，更不该影响条目保存与既有索引。
 *  日志把三种结局分开写（成功/截断/未提取到文字/失败），事后查「为什么这条没被检索到」全靠它。 */
async function parseOne(f: FileRow, name: string, allowance: number, parse: ParseFn): Promise<string> {
  try {
    const r = await parse({ key: f.key, maxChars: allowance })
    if (r.no_text) {
      console.warn(`library 附件未提取到文字 name=${name} 仍看不见 ${r.image_pages} 页（已识别 ${r.ocr_pages} 页）`)
      return ""
    }
    if (r.truncated) console.warn(`library 附件正文超上限已截断 name=${name} 保留 ${r.chars} 字`)
    console.info(`library 附件正文已解析 name=${name} 字数=${r.chars} 识别页=${r.ocr_pages}`)
    // UTF-16 安全截断（见 lib/text.ts）：agent 按码点截，JS 按码位算长度，星平面字符会让
    // 两边对不上；这里是落库前与 zod 上限对齐的最后一道，裸 slice 会切出孤代理。
    return sliceAtCodePoint(r.text, ATTACHMENT_TEXT_MAX_CHARS)
  } catch (e) {
    console.warn(`library 附件正文解析失败 name=${name}:`, e)
    return ""
  }
}

/** 逐个附件解析（串行：agent 那头的 OCR 有进程级闸，并发投递只是排更长的队）→ 新附件列表。 */
async function parseAll(
  attachments: Attachment[],
  byId: Map<string, FileRow>,
  parse: ParseFn,
): Promise<{ next: Attachment[]; changed: boolean }> {
  let used = attachments.reduce((n, a) => n + (a.text?.length ?? 0), 0) // 已有正文也占条目预算
  let changed = false
  const next: Attachment[] = []
  for (const a of attachments) {
    const f = byId.get(a.fileId)
    // 已解析过 / 文件不在（他人或已删）/ 非文档类（图片走 ocrText）→ 原样保留
    if (a.text || !f || !DOC_EXTS.has(extOf(f.key))) {
      next.push(a)
      continue
    }
    const allowance = Math.min(ATTACHMENT_TEXT_MAX_CHARS, ITEM_TEXT_BUDGET_CHARS - used)
    if (f.size > PARSE_MAX_BYTES || allowance <= 0) {
      console.warn(`library 附件跳过解析 name=${a.name} 体积=${f.size} 剩余预算=${allowance}`)
      next.push(a)
      continue
    }
    const text = await parseOne(f, a.name, allowance, parse)
    if (!text) {
      next.push(a)
      continue
    }
    used += text.length
    changed = true
    next.push({ ...a, text })
  }
  return { next, changed }
}

/**
 * 附件正文解析回写（spec 2026-08-11）：条目保存后由 routes/library 的 enrichAttachments 触发，
 * 给该条目里「文档扩展 + 尚无 text」的附件逐个解析（扫描版 PDF 在 agent 侧走 OCR），
 * 结果整列写回 attachments（jsonb），带 userId 归属条件。
 * 返回**是否真的写回了新正文**——调用方据此决定要不要重建 RAG 索引（没变就别白花一次 embed）。
 *
 * 全程不抛：DB/agent 任一环节故障都只放弃这次回填，调用方无需 catch。
 * parse 可注入（默认真实 parseAttachmentText，与 services/library-ocr 的 ocr 注入同一手法）：
 * 测试注入假实现，不用 mock.module——那是进程级全局替换，会泄漏给同进程的其它测试文件。
 */
export async function backfillAttachmentText(
  itemId: string,
  userId: string,
  parse: ParseFn = parseAttachmentText,
): Promise<boolean> {
  try {
    const [item] = await getDb()
      .select({ attachments: libraryItems.attachments })
      .from(libraryItems)
      .where(and(eq(libraryItems.id, itemId), eq(libraryItems.userId, userId)))
    const attachments = item?.attachments as Attachment[] | null | undefined
    if (!attachments || attachments.length === 0) return false

    const fileIds = [...new Set(attachments.map((a) => a.fileId))]
    const files = await getDb()
      .select({ id: projectFiles.id, key: projectFiles.key, size: projectFiles.size })
      .from(projectFiles)
      .where(and(inArray(projectFiles.id, fileIds), eq(projectFiles.userId, userId)))
    const { next, changed } = await parseAll(attachments, new Map(files.map((f) => [f.id, f])), parse)
    if (!changed) return false

    // 整列 jsonb 条件更新 + 乐观锁（口径同 services/library-ocr.ts）：解析是分钟量级的慢操作，
    // 这期间用户完全可能又保存了一次（增删附件）——不带「attachments 仍等于开工前的快照」
    // 这道比较，就会用旧快照整列覆写，把用户刚做的改动静默吞掉。比对不上 = 有人抢先改过，
    // 按 best-effort 哲学放弃本次回填：下次保存会重新触发一轮解析。
    const written = await getDb()
      .update(libraryItems)
      .set({ attachments: next })
      .where(
        and(
          eq(libraryItems.id, itemId),
          eq(libraryItems.userId, userId),
          eq(libraryItems.attachments, attachments),
        ),
      )
      .returning({ id: libraryItems.id })
    return written.length > 0
  } catch (e) {
    console.warn(`library 附件正文回填失败 itemId=${itemId}:`, e)
    return false
  }
}
