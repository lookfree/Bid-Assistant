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

/** 远程图片 URL → 压缩 data URL。资料库附件走预签名下载地址取回后内嵌，
 *  与本地选图同一条压缩路径（内嵌自包含、不受预签名过期影响，导出时渲染器直接解码落图）。 */
export async function imageUrlToDataUrl(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch image ${res.status}`)
  const blob = await res.blob()
  return imageFileToDataUrl(new File([blob], "attachment", { type: blob.type || "image/jpeg" }))
}

/** alt 的最大长度：它会被原样喂给审查模型（见 agent 侧 strip_inline_images），
 *  太长会把章节的截断预算又吃回去——一行提示足够，不是全文。 */
const ALT_MAX = 200

/** HTML 属性值转义。只转 " 是不够的：识别文字里出现 `>`（"投标报价 > 100万" 这种很常见）
 *  会让 agent 侧的 `<img[^>]*>` 提前收尾，alt 取不全、标签残片还会当正文喂给模型。 */
export function escAttrValue(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

/** 拼 <img alt>：资料标题 + 文件名 + OCR 识别文字。
 *  审查靠这行字判断"这份材料在不在"——只有文件名（图片1.png）时它判断不了。
 *
 *  标题放最前，有两个理由：一是它是用户自己起的（「营业执照」），最能说明这是什么，而文件名
 *  常常是 flink-logo.png 这种毫无关系的名字（2026-08-07 线上实例）；二是 alt 有 200 字上限，
 *  识别文字长了会被截掉，放前面才保证这条最有用的信息一定活下来。
 *  识别不出文字时（logo、纯图章、低置信度）也照样有标题可给模型，不至于只剩文件名。 */
export function imageAlt(name: string, ocrText: string, title = ""): string {
  const parts = [title.trim(), name.trim(), ocrText.replace(/\s+/g, " ").trim()].filter(Boolean)
  // 标题与文件名常常重复（「营业执照」+「营业执照.png」），重复一遍只是白占 alt 的额度
  const seen = new Set<string>()
  const uniq = parts.filter((p) => {
    const k = p.toLowerCase().replace(/\.(png|jpe?g)$/i, "")
    return seen.has(k) ? false : (seen.add(k), true)
  })
  return (uniq.join("｜") || "插图").slice(0, ALT_MAX)
}

/** 调后端识别图片文字。任何失败都回空串——识别是增强，绝不该挡住插图本身。 */
export async function ocrDataUrl(dataUrl: string): Promise<string> {
  try {
    const { api } = await import("./api")
    const r = await api.request<{ text: string }>("/files/ocr", {
      method: "POST",
      body: JSON.stringify({ image: dataUrl }),
    })
    return r.text ?? ""
  } catch {
    return ""
  }
}
