// 编辑器插图：本地图片 → 压缩后的 data URL 内嵌正文。
// 为什么内嵌而不传 MinIO：预签名 URL 会过期（存进正文的 <img src> 迟早变死图），而 C 端
// 鉴权走 Bearer 头、<img> 发不出去。内嵌自包含、永不失效，导出 docx 时渲染器直接解码落图。
// 为什么压缩：公网带宽极差（实测 21-75KB/s），原图 MB 级内嵌会把章节 HTML 拖到不可用。
const MAX_DIM = 1200
const JPEG_QUALITY = 0.85

/** 图片文件 → 压缩 data URL（最长边 ≤1200px 的 JPEG；解码失败抛错，调用方给提示）。 */
export async function imageFileToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement("canvas")
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("canvas unavailable")
    ctx.fillStyle = "#ffffff" // JPEG 无透明通道：透明底 PNG 压白底，别压成黑底
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(bitmap, 0, 0, w, h)
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY)
  } finally {
    bitmap.close()
  }
}
