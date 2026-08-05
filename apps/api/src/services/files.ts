import { randomUUID } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { getDb } from "../db/client"
import { projectFiles, type ProjectFile } from "../db/schema"
import { bucket, presignPut, presignGet, headObject, deleteObject, getObjectHead } from "../storage/s3"
import { getEnv } from "../config/env"
import { checkFileMagic, MAGIC_SAMPLE_BYTES } from "./file-magic"

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
// pptx/potx（企业 PPT 母版）：同理不进读标解析，只是资料库 presentation 分类条目挂的母版文件，
// 供 present/export 步按 enterprise_template_key 取字节套用客户自有主题。
const SUPPORTED_EXTS = new Set(["pdf", "docx", "xlsx", "doc", "xls", "png", "jpg", "jpeg", "pptx", "potx"])

export class UnsupportedFileTypeError extends Error {
  constructor() {
    super("unsupported_file_type")
    this.name = "UnsupportedFileTypeError"
  }
}

/** 扩展名对、内容不对：被文档加密软件封装成密文，或内容根本不是该格式。
 *  只带错误码——面向用户的中文文案统一在 web 的 uploadErrorMessage 里，避免同一句话两处各存一份。 */
export class FileContentRejectedError extends Error {
  constructor(public readonly code: "encrypted_wrapper" | "content_mismatch") {
    super(code)
    this.name = "FileContentRejectedError"
  }
}

const extOf = (filename: string) => filename.split(".").pop()?.toLowerCase() ?? ""

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
  if (!SUPPORTED_EXTS.has(extOf(input.filename))) throw new UnsupportedFileTypeError()
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

/** 按文件头校验内容与扩展名相符，不符则删对象 + 拒绝——加密封装/损坏的文件绝不进入后续流程。
 *  这是主防线：此前这类文件一路走到读标才失败，还会被报成模型问题（见 file-magic.ts 注释）。 */
async function rejectIfContentMismatch(key: string, filename: string, size: number): Promise<void> {
  // 空对象无范围可读（MinIO 对 0 字节对象的 Range 请求返回 416），直接交给校验判为不符。
  const sample =
    size > 0 ? await getObjectHead(key, Math.min(MAGIC_SAMPLE_BYTES, size)) : new Uint8Array(0)
  const verdict = checkFileMagic(sample, extOf(filename))
  if (verdict.ok) return
  await deleteObject(key).catch(() => {})
  throw new FileContentRejectedError(verdict.code)
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
// 后上传超大对象），超限则删对象+拒绝；再按文件头校验内容与扩展名相符；否则落 uploaded + size/etag。
export async function confirmUpload(fileId: string, userId: string): Promise<ProjectFile> {
  const file = await ownFile(fileId, userId)
  const head = await headObject(file.key)
  if (!head) throw new ObjectMissingError()
  if (head.size > fileMaxBytes()) {
    await deleteObject(file.key).catch(() => {})
    throw new FileTooLargeError()
  }
  await rejectIfContentMismatch(file.key, file.filename, head.size)
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
