"use client"

import Link from "next/link"
import { Loader2 } from "lucide-react"

// 各工具页共用的「步骤运行中 / 失败重试」横幅（/read /outline /content /present）。
export function StepBanner({
  running,
  error,
  runningText,
  progress,
  onRetry,
  action,
}: {
  running: boolean
  error: string | null
  runningText: string
  /** 当前阶段的完成度（服务端结构化下发的 done/total）。给了就画进度条，没给只显示文案。 */
  progress?: { done: number; total: number } | null
  onRetry: () => void
  /** 失败时的引导链接（如 402 积分不足 → 去充值），有则替代「重试」按钮 */
  action?: { href: string; label: string }
}) {
  // 百分比夹在 0–100：done/total 来自服务端，续跑复用等情形下不该因为一次异常计数就画出 137%。
  const pct = progress && progress.total > 0
    ? Math.min(100, Math.max(0, Math.round((progress.done / progress.total) * 100)))
    : null
  if (running)
    return (
      <div className="mb-4 rounded-2xl border border-primary/20 gradient-brand-soft px-4 py-3 text-sm font-medium text-primary">
        <div className="flex items-center gap-2">
          <Loader2 className="size-4 shrink-0 animate-spin" />
          <span className="min-w-0 flex-1">{runningText}</span>
          {pct !== null && <span className="shrink-0 tabular-nums">{pct}%</span>}
        </div>
        {/* 进度条只反映**当前阶段**的完成度（解析/识别/并行提取各报各的，见 publish_phase）：
            读标不同阶段耗时差得远，硬凑成一条全局百分比只会给出一个假的时间预期。 */}
        {pct !== null && (
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-primary/15">
            <div className="h-full rounded-full gradient-brand transition-[width] duration-500" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
    )
  if (error)
    return (
      <div className="mb-4 flex items-center justify-between rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        <span>{error}</span>
        {action ? (
          <Link href={action.href} className="rounded-lg border border-destructive/30 px-3 py-1 text-xs font-semibold">
            {action.label}
          </Link>
        ) : (
          <button onClick={onRetry} className="rounded-lg border border-destructive/30 px-3 py-1 text-xs font-semibold">
            重试
          </button>
        )}
      </div>
    )
  return null
}
