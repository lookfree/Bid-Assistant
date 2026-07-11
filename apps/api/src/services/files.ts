import { randomUUID } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { getDb } from "../db/client"
import { projectFiles, type ProjectFile } from "../db/schema"
import { bucket, presignPut, presignGet, headObject, deleteObject } from "../storage/s3"
import { getEnv } from "../config/env"

/** 超过大小上限（预签名时按声明值、确认时按真实对象大小复验）。 */
export class FileTooLargeError extends Error {
  constructor() {
    super("file_too_large")
    this.name = "FileTooLargeError"
  }
}
/** 文件不存在或不属于当前用户。 */
export class FileNotFoundError extends Error {
  constructor() {
    super("not_found")
    this.name = "FileNotFoundError"
  }
}
/** 元数据存在但 MinIO 上对象未落（客户端未真正上传即调 complete）。 */
export class ObjectMissingError extends Error {
  constructor() {
    super("object_missing")
    this.name = "ObjectMissingError"
  }
}

// 大小上限（字节）：MB→B 换算收一处，预签名与确认两处校验共用，边界不会各自漂移。
const fileMaxBytes = () => getEnv().FILE_MAX_SIZE_MB * 1024 * 1024

// 解析层（agent parsing）支持的扩展名：上传入口 fail fast，别让用户走到读标扣费后才发现解析必败。
// doc/xls（旧格式）spec320 起经 agent 侧 LibreOffice 转 docx/xlsx 再解析。
// png/jpg/jpeg（spec325）：资质证照图片附件——不进读标解析，只是资料库挂图供导出附录用，
// 复用同一条预签名上传通道；agent 解析器对图片仍抛 UnsupportedDocument（白名单放宽不影响招标文件流）。
const SUPPORTED_EXTS = new Set(["pdf", "docx", "xlsx", "doc", "xls", "png", "jpg", "jpeg"])

export class UnsupportedFileTypeError extends Error {
  constructor() {
    super("unsupported_file_type")
    this.name = "UnsupportedFileTypeError"
  }
}

// 文件名清洗：仅留字母数字下划线点连字符与中文，截断到 120，避免 key 注入/超长。
function sanitize(name: string): string {
  return name.replace(/[^\w.\-一-龥]/g, "_").slice(0, 120)
}

// 建 pending 元数据行 + 返回预签名 PUT；浏览器凭 uploadUrl 直传到 MinIO。
export async function presignUpload(input: {
  userId: string
  filename: string
  contentType: string
  size: number
}): Promise<{ fileId: string; key: string; uploadUrl: string }> {
  const env = getEnv()
  if (input.size > fileMaxBytes()) throw new FileTooLargeError()
  const ext = input.filename.split(".").pop()?.toLowerCase() ?? ""
  if (!SUPPORTED_EXTS.has(ext)) throw new UnsupportedFileTypeError()
  const key = `uploads/${input.userId}/${randomUUID()}/${sanitize(input.filename)}`
  const [row] = await getDb()
    .insert(projectFiles)
    .values({
      userId: input.userId,
      bucket: bucket(),
      key,
      filename: input.filename,
      contentType: input.contentType,
      size: input.size,
      status: "pending",
    })
    .returning()
  const uploadUrl = await presignPut(key, input.contentType, env.FILE_PRESIGN_TTL_SECONDS)
  return { fileId: row!.id, key, uploadUrl }
}

// 取属于本人的文件行（仅本人可见，§9）；不存在抛 not_found。
async function ownFile(fileId: string, userId: string): Promise<ProjectFile> {
  const [row] = await getDb()
    .select()
    .from(projectFiles)
    .where(and(eq(projectFiles.id, fileId), eq(projectFiles.userId, userId)))
    .limit(1)
  if (!row) throw new FileNotFoundError()
  return row
}

// 确认上传：HEAD 校验对象真存在，并按真实大小复验上限（预签名 PUT 无长度约束，客户端可少报 size
// 后上传超大对象），超限则删对象+拒绝；否则落 uploaded + size/etag。
export async function confirmUpload(fileId: string, userId: string): Promise<ProjectFile> {
  const file = await ownFile(fileId, userId)
  const head = await headObject(file.key)
  if (!head) throw new ObjectMissingError()
  if (head.size > fileMaxBytes()) {
    await deleteObject(file.key).catch(() => {})
    throw new FileTooLargeError()
  }
  const [updated] = await getDb()
    .update(projectFiles)
    .set({ status: "uploaded", size: head.size, etag: head.etag })
    .where(eq(projectFiles.id, fileId))
    .returning()
  return updated!
}

// 预签名下载：仅本人；附件名用原始 filename。
export async function presignDownload(
  fileId: string,
  userId: string,
): Promise<{ url: string; filename: string }> {
  const file = await ownFile(fileId, userId)
  const url = await presignGet(file.key, getEnv().FILE_PRESIGN_TTL_SECONDS, file.filename)
  return { url, filename: file.filename }
}
