import { and, eq, inArray } from "drizzle-orm"
import { getDb } from "../db/client"
import { libraryItems, projectFiles } from "../db/schema"
import { getObjectBytes } from "../storage/s3"
import { ocrImage } from "./ocr"

// 只认图片扩展（与 credentials.ts 的 IMAGE_EXTS 同口径：docx 无法内嵌 pdf，OCR 同理只对图片有意义）
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg"])

function extOf(key: string): string {
  return key.split(".").pop()?.toLowerCase() ?? ""
}

// 单附件识别：下载字节 → 拼 data URL → 调 OCR；下载或识别任一环节失败按「未识别到文字」处理，
// 不向上抛——失败是这一个附件的事，不该拖累同条目里的其它附件。
async function recognize(key: string, ext: string): Promise<string> {
  try {
    const bytes = await getObjectBytes(key)
    const base64 = Buffer.from(bytes).toString("base64")
    const text = await ocrImage(`data:image/${ext};base64,${base64}`)
    // 纵深防御（终审 I-2）：与 routes/library.ts 的 zod ocrText max(500) 对齐——OCR 容器不受
    // 我们控制，一旦哪次识别失约返回超长文本，写库时不截断的话，这条 ocrText 从此每次保存
    // （包括用户压根没碰这个字段的整条更新）都会撞 zod 400，把条目锁死在无法保存的状态。
    return text.slice(0, 500)
  } catch {
    return ""
  }
}

/**
 * 附件 OCR 前置存储（基建，spec 2026-08-09）：条目保存后由路由层 fire-and-forget 触发，
 * 给该条目里「图片扩展 + 尚无 ocrText」的附件逐个识别，结果整列写回 attachments（jsonb），
 * 带 userId 归属条件。已有 ocrText 的附件不重复识别；非图片扩展的附件跳过。
 * 全程不抛：DB/S3/OCR 任一环节故障都只放弃这次回填，调用方无需 catch。
 */
export async function backfillAttachmentOcr(itemId: string, userId: string): Promise<void> {
  try {
    const [item] = await getDb()
      .select({ attachments: libraryItems.attachments })
      .from(libraryItems)
      .where(and(eq(libraryItems.id, itemId), eq(libraryItems.userId, userId)))
    const attachments = item?.attachments
    if (!attachments || attachments.length === 0) return

    const fileIds = [...new Set(attachments.map((a) => a.fileId))]
    const files = await getDb()
      .select({ id: projectFiles.id, key: projectFiles.key })
      .from(projectFiles)
      .where(and(inArray(projectFiles.id, fileIds), eq(projectFiles.userId, userId)))
    const keyById = new Map(files.map((f) => [f.id, f.key]))

    let changed = false
    const next = []
    for (const a of attachments) {
      const key = keyById.get(a.fileId)
      const ext = key ? extOf(key) : ""
      if (a.ocrText || !key || !IMAGE_EXTS.has(ext)) {
        next.push(a)
        continue
      }
      const text = await recognize(key, ext)
      if (text) {
        changed = true
        next.push({ ...a, ocrText: text })
      } else {
        next.push(a)
      }
    }
    if (!changed) return

    // 整列 jsonb 条件更新，带 userId 归属——与 attachmentsValid/cleanupAttachments 同样的属主校验手法。
    // WHERE 再带上「attachments 仍等于识别开始前读到的快照」这道乐观锁：识别是秒级的慢操作，
    // 这期间用户完全可能又保存了一次（增删附件）——不带这道比较会用旧快照整列覆写，
    // 把用户刚做的改动静默吞掉（新附件消失/已删附件复活）。比对不上 = 有人抢先改过，
    // 按 best-effort 哲学放弃本次回填，不重试不报错：下次保存会重新触发一轮 OCR。
    await getDb()
      .update(libraryItems)
      .set({ attachments: next })
      .where(
        and(
          eq(libraryItems.id, itemId),
          eq(libraryItems.userId, userId),
          eq(libraryItems.attachments, attachments),
        ),
      )
  } catch {
    // 全程不抛：调用方是 fire-and-forget，任何环节故障都只静默放弃这次回填
  }
}
