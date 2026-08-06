import { getEnv } from "../config/env"

// 正文插图的文字识别（spec-ocr）。识别在**独立的 OCR 服务**里做（231 上的容器），
// App 这层只做中转：拿到文字后由前端写进 <img alt>，审查侧的 strip_inline_images
// 会把 alt 透出给模型——于是「［图片：营业执照.png］」变成带识别文字的版本，
// 审查才判断得出材料在不在（2026-08-06 用户反馈：证照以图片放进正文，审查报缺件）。
//
// 客户不允许业务数据出内网（发出去的是营业执照、法人身份证这类），故本地识别而非云 OCR。

/** OCR 未配置：环境没部署该服务时整条链路静默降级，不影响插图本身。 */
export class OcrUnconfiguredError extends Error {
  constructor() {
    super("ocr_unconfigured")
    this.name = "OcrUnconfiguredError"
  }
}

/** 识别超时（秒）：单张证照实测 1 秒内；给足余量但绝不让用户干等。 */
const TIMEOUT_MS = 15_000

export async function ocrImage(imageBase64: string, maxChars = 400): Promise<string> {
  const base = getEnv().OCR_BASE_URL
  if (!base) throw new OcrUnconfiguredError()
  const res = await fetch(`${base.replace(/\/$/, "")}/ocr`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image: imageBase64, max_chars: maxChars }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`ocr_failed_${res.status}`)
  const body = (await res.json()) as { text?: string }
  return (body.text ?? "").trim()
}
