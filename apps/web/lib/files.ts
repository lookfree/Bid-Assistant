import { api } from "./api"
import { ApiError } from "./api-client"

// 通用文件直传/下载封装：三段式直传（presign 建元数据+签 URL → 浏览器 PUT 直传 MinIO →
// complete 校验落 uploaded），与 upload 页同一链路；下载走预签名 URL 浏览器直下。

export type UploadedFile = { fileId: string; key: string; name: string }

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
    if (e.code === "file_too_large") return "文件过大，超出上传大小上限"
  }
  return fallback
}
