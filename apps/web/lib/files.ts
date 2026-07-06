import { api } from "./api"

// 通用文件直传/下载封装：三段式直传（presign 建元数据+签 URL → 浏览器 PUT 直传 MinIO →
// complete 校验落 uploaded），与 upload 页同一链路；下载走预签名 URL 浏览器直下。

export type UploadedFile = { fileId: string; name: string }

export async function uploadFile(file: File): Promise<UploadedFile> {
  const contentType = file.type || "application/octet-stream"
  const { fileId, uploadUrl } = await api.request<{ fileId: string; uploadUrl: string }>("/files/presign-upload", {
    method: "POST",
    body: JSON.stringify({ filename: file.name, contentType, size: file.size }),
  })
  const res = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": contentType }, body: file })
  if (!res.ok) throw new Error("upload failed")
  await api.request(`/files/${fileId}/complete`, { method: "POST" })
  return { fileId, name: file.name }
}

export async function fileDownloadUrl(fileId: string): Promise<string> {
  const { url } = await api.request<{ url: string }>(`/files/${fileId}/download-url`)
  return url
}
