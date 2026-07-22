// 生成配置（spec330）：目标字数 + 输出格式。偏好存 localStorage（用户级,下次默认带出）;
// 格式键名与后端 zod 白名单/agent 渲染契约一致（snake_case 直传）。
export type DocFormat = {
  margin_cm?: { top?: number; bottom?: number; left?: number; right?: number }
  heading_font?: string
  heading_size?: string
  heading_bold?: boolean
  body_font?: string
  body_size?: string
  body_indent_chars?: 0 | 2
  line_spacing?: 1 | 1.5 | "fixed22"
}

export type GenerationConfig = { targetChars: number; format: DocFormat }

/** 默认格式（用户 2026-07-23 提供的口径,与 agent 渲染端 _FMT_DEFAULT 一致） */
export const DEFAULT_FORMAT: Required<Omit<DocFormat, "margin_cm">> & { margin_cm: Required<NonNullable<DocFormat["margin_cm"]>> } = {
  margin_cm: { top: 2.2, bottom: 2.2, left: 2.3, right: 2.3 },
  heading_font: "宋体",
  heading_size: "四号",
  heading_bold: true,
  body_font: "宋体",
  body_size: "小四",
  body_indent_chars: 2,
  line_spacing: 1.5,
}

export const TARGET_MIN = 10_000
export const TARGET_MAX = 500_000

/** 推荐目标字数：章节数 × 3000,夹在滑杆范围内。 */
export function suggestedTarget(chapterCount: number): number {
  return Math.min(TARGET_MAX, Math.max(TARGET_MIN, chapterCount * 3000))
}

const KEY = "bid.genConfig"

export function loadGenConfig(): Partial<GenerationConfig> {
  if (typeof window === "undefined") return {}
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<GenerationConfig>
  } catch {
    return {}
  }
}

export function saveGenConfig(cfg: GenerationConfig): void {
  if (typeof window !== "undefined") localStorage.setItem(KEY, JSON.stringify(cfg))
}

/** 导出时读存好的格式（未配置过返回 undefined → 请求不带 format,后端走现行样式）。 */
export function storedFormat(): DocFormat | undefined {
  const f = loadGenConfig().format
  return f && Object.keys(f).length > 0 ? f : undefined
}
