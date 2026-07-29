import { api } from "./api"
import { ApiError } from "./api-client"

// 通用文件直传/下载封装：三段式直传（presign 建元数据+签 URL → 浏览器 PUT 直传 MinIO →
// complete 校验落 uploaded），与 upload 页同一链路；下载走预签名 URL 浏览器直下。

export type UploadedFile = { fileId: string; key: string; name: string }

/* ==================== 全系统上传口径（唯一真相） ====================
 * 大小上限与可选格式一律从这里取，各入口不要再各自写死——查重页曾标「≤ 100 MB」而
 * 服务端 50MB 直接拒（用户传完才被 400，白等一场），模板入口曾放行 .ppt 而服务端白名单
 * 只认 .pptx/.potx。服务端权威：apps/api 的 FILE_MAX_SIZE_MB（默认 50）与
 * services/files.ts 的 SUPPORTED_EXTS；这里是**展示口径**，改服务端时同步改这里。 */

/** 单文件大小上限（MB），与 API 的 FILE_MAX_SIZE_MB 默认值一致。 */
export const UPLOAD_MAX_MB = 50

/** 投标文件/标书：正文类文档。 */
export const ACCEPT_BID = ".pdf,.docx,.doc"
/** 招标文件：可能带清单/报价表格，故比标书多收 Excel。 */
export const ACCEPT_TENDER = ".pdf,.docx,.doc,.xlsx,.xls"
/** 述标 PPT 母版与参考稿（服务端白名单不含 .ppt，别放行）。 */
export const ACCEPT_PPT = ".pptx,.potx"
/** 资质证照等图片附件。 */
export const ACCEPT_IMAGE = ".png,.jpg,.jpeg"

// 扩展名 → 展示名。同族合并（docx/doc 都叫 Word），避免「Word（.docx）、Word（.doc）」的啰嗦文案。
const EXT_FAMILY: Record<string, string> = {
  pdf: "PDF", docx: "Word", doc: "Word", xlsx: "Excel", xls: "Excel",
  pptx: "PPT", potx: "PPT", png: "图片", jpg: "图片", jpeg: "图片",
}

/** 上传提示文案（全系统统一句式）：「支持 PDF、Word、Excel · 单文件最大 50MB」。
 *  multiple=true 时追加「· 可一次选择多个文件」。 */
export function uploadHint(accept: string, opts: { multiple?: boolean } = {}): string {
  const families: string[] = []
  for (const ext of accept.split(",")) {
    const fam = EXT_FAMILY[ext.trim().replace(/^\./, "")]
    if (fam && !families.includes(fam)) families.push(fam)
  }
  const parts = [`支持 ${families.join("、")}`, `单文件最大 ${UPLOAD_MAX_MB}MB`]
  if (opts.multiple) parts.push("可一次选择多个文件")
  return parts.join(" · ")
}

export async function uploadFile(file: File): Promise<UploadedFile> {
  const contentType = file.type || "application/octet-stream"
  // presign 响应含 MinIO 对象 key（后端以 key 定位文件，如查重 fileKeys / 项目 fileKey）
  const { fileId, key, uploadUrl } = await api.request<{ fileId: string; key: string; uploadUrl: string }>(
    "/files/presign-upload",
    {
      method: "POST",
      body: JSON.stringify({ filename: file.name, contentType, size: file.size }),
    },
  )
  const res = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": contentType }, body: file })
  if (!res.ok) throw new Error("upload failed")
  await api.request(`/files/${fileId}/complete`, { method: "POST" })
  return { fileId, key, name: file.name }
}

export async function fileDownloadUrl(fileId: string): Promise<string> {
  const { url } = await api.request<{ url: string }>(`/files/${fileId}/download-url`)
  return url
}

/** 上传失败的用户可读文案：类型/大小被拒给出**具体原因**（通用「上传失败请重试」会让用户
 *  拿着同一个坏文件反复重试——生产实测：选了 Chrome 未下载完的 .crdownload 残尾文件却不知为何失败）。 */
export function uploadErrorMessage(e: unknown, fallback = "上传失败，请重试"): string {
  if (e instanceof ApiError) {
    if (e.code === "unsupported_file_type")
      return "不支持的文件类型：请上传 PDF / Word / Excel / PPT 或图片（png/jpg）。若文件名以 .crdownload 结尾，说明浏览器尚未下载完成，请等原文件下载完再上传"
    if (e.code === "file_too_large") return `文件过大：单文件最大 ${UPLOAD_MAX_MB}MB`
  }
  return fallback
}

/** 每次提交最多带几份文件（与 API 的 keyList max(10) 对齐；超了服务端 400 且不说是哪一条） */
export const UPLOAD_MAX_FILES = 10

/** 选文件时的前置校验：类型/大小/份数。返回 null=通过，否则是给用户看的原因。
 *  拖拽会绕过 input 的 accept，不在这里拦就要等全部直传完成、服务端 400 之后才知道白等一场。 */
export function checkFiles(picked: File[], accept: string, already = 0): string | null {
  const exts = accept.split(",").map((e) => e.trim().toLowerCase())
  const bad = picked.find((f) => !exts.some((e) => f.name.toLowerCase().endsWith(e)))
  if (bad) return `「${bad.name}」格式不支持（${uploadHint(accept)}）`
  const tooBig = picked.find((f) => f.size > UPLOAD_MAX_MB * 1024 * 1024)
  if (tooBig) return `「${tooBig.name}」超过 ${UPLOAD_MAX_MB}MB，请压缩或拆分后再传`
  if (already + picked.length > UPLOAD_MAX_FILES) return `最多 ${UPLOAD_MAX_FILES} 份，请先移除多余文件`
  return null
}
